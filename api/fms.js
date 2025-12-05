// /api/fms.js
//
// FULL PRODUCTION VERSION
// - Unified backend for Trip Tasks, File Lookup, File Upload,
//   Check-in, Cancel, POD/BOL enforcement
//
// Uses FMS credentials from env:
//   FMS_USER, FMS_PASS
//

/* =====================================================
   CONFIG
=====================================================*/

const FMS_BASE = "https://fms.item.com";

const LOGIN_URL = `${FMS_BASE}/fms-platform-user/Auth/Login`;
const TASKS_URL = `${FMS_BASE}/fms-platform-dispatch-management/TripDetail/GetTaskList`;

const FILES_URL = `${FMS_BASE}/fms-platform-dispatch-management/Trips/GetFileInfoByTripId`;

const FILE_UPLOAD_URL = `${FMS_BASE}/fms-platform-file/Storage/Upload`;

const TASK_COMPLETE_URL = `${FMS_BASE}/fms-platform-dispatch-management/TripDetail/TaskComplete`;
const TASK_CANCEL_URL = `${FMS_BASE}/fms-platform-dispatch-management/TripDetail/TaskCompleteCancel`;

const LH_REVERT_URL = `${FMS_BASE}/fms-platform-dispatch-management/lh/revert-arrived`;

const FMS_CLIENT = "FMS_WEB";
const COMPANY_ID = "SBFH";

/* =====================================================
   ENV
=====================================================*/

const FMS_USER = process.env.FMS_USER;
const FMS_PASS = process.env.FMS_PASS;

if (!FMS_USER || !FMS_PASS) {
  throw new Error("Missing env vars FMS_USER / FMS_PASS");
}

/* =====================================================
   TOKEN CACHE
=====================================================*/

let FMS_TOKEN = null;
let AUTH_TOKEN = null;
let TOKEN_TS = 0;

const TOKEN_TTL = 55 * 60 * 1000;

/* =====================================================
   LOGIN
=====================================================*/

async function fmsLogin(force = false) {
  const now = Date.now();

  if (
    !force &&
    FMS_TOKEN &&
    AUTH_TOKEN &&
    now - TOKEN_TS < TOKEN_TTL
  ) {
    return {
      fmsToken: FMS_TOKEN,
      authToken: AUTH_TOKEN
    };
  }

  const resp = await fetch(LOGIN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "fms-client": FMS_CLIENT
    },
    body: JSON.stringify({
      account: FMS_USER,
      password: FMS_PASS
    })
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`FMS login failed: ${t}`);
  }

  const json = await resp.json().catch(() => null);
  const data = json?.data || json || {};

  const fms = data.token;
  const auth = data.third_party_token || data.thirdPartyToken;

  if (!fms || !auth) {
    throw new Error("Login succeeded but tokens were missing");
  }

  FMS_TOKEN = fms;
  AUTH_TOKEN = auth;
  TOKEN_TS = now;

  return {
    fmsToken: fms,
    authToken: auth
  };
}

/* =====================================================
   AUTH HEADERS
=====================================================*/

async function getHeaders(extra = {}) {
  const { fmsToken, authToken } = await fmsLogin(false);

  return {
    Accept: "application/json, text/plain, */*",
    Authorization: authToken,
    "fms-token": fmsToken,
    "company-id": COMPANY_ID,
    "fms-client": FMS_CLIENT,
    ...extra
  };
}

/* =====================================================
   FETCH WITH RETRY
=====================================================*/

async function fmsFetch(url, options = {}, retry = 0) {
  const headers = await getHeaders(options.headers || {});

  const resp = await fetch(url, {
    ...options,
    headers
  });

  if ((resp.status === 401 || resp.status === 403) && retry < 1) {
    await fmsLogin(true);
    return fmsFetch(url, options, retry + 1);
  }

  return resp;
}

/* =====================================================
   NORMALIZATION
=====================================================*/

const clean = (v) => String(v ?? "").trim();

function normalizeTask(t) {
  return {
    do: clean(t.order_no),
    pro: clean(t.tracking_no),
    pu: clean(t.pu_no),
    taskNo: Number(t.task_no),
    type: clean(t.task_type_text),
    status: clean(t.status_text),
    complete: clean(t.status_text).toLowerCase() === "complete"
  };
}

/* =====================================================
   FILE UPLOAD HELPERS
=====================================================*/

function resolveUploadDirectory(taskType) {
  if (taskType.toLowerCase().includes("pick")) return "fms_order_bol";
  if (taskType.toLowerCase().includes("deliv")) return "fms_trip_pod";
  return "fms_trip_other";
}

function resolveImageType(taskType) {
  if (taskType.toLowerCase().includes("pick")) return "BOL";
  if (taskType.toLowerCase().includes("deliv")) return "POD";
  return "OTHER";
}

/* =====================================================
   MAIN HANDLER
=====================================================*/

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { action } = req.body || {};

    /* ------------------------------------------------
       getTasks
    ------------------------------------------------ */
    if (action === "getTasks") {
      const { tripNo } = req.body;
      if (!tripNo) return res.status(400).json({ error: "tripNo required" });

      const url = `${TASKS_URL}?tripNo=${encodeURIComponent(tripNo)}`;

      const resp = await fmsFetch(url, { method: "GET" });

      if (!resp.ok) {
        const t = await resp.text();
        return res.status(resp.status).json({
          error: "FMS TaskList failed",
          details: t
        });
      }

      const json = await resp.json();
      const raw = json?.data || [];
      const tasks = raw.map(normalizeTask);

      return res.json({ tripNo, tasks });
    }

    /* ------------------------------------------------
       getTripFiles
    ------------------------------------------------ */
    if (action === "getTripFiles") {
      const { tripNo } = req.body;
      if (!tripNo) return res.status(400).json({ error: "tripNo required" });

      const resp = await fmsFetch(FILES_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trip_no: tripNo })
      });

      const json = await resp.json().catch(() => ({}));
      return res.json(json);
    }

    /* ------------------------------------------------
       uploadFile
       (frontend sends raw base64 file)
    ------------------------------------------------ */
    if (action === "uploadFile") {
      const { fileBase64, filename, taskType } = req.body;

      if (!fileBase64 || !filename || !taskType) {
        return res.status(400).json({
          error: "fileBase64, filename, taskType required"
        });
      }

      const directory = resolveUploadDirectory(taskType);

      const boundary = "----FMSFormBoundary" + Math.random().toString(16);

      const bodyParts = [];
      const append = (str) => bodyParts.push(Buffer.from(str, "utf8"));

      append(`--${boundary}\r\n`);
      append(`Content-Disposition: form-data; name="files"; filename="${filename}"\r\n`);
      append(`Content-Type: application/octet-stream\r\n\r\n`);
      bodyParts.push(Buffer.from(fileBase64, "base64"));
      append(`\r\n--${boundary}\r\n`);
      append(`Content-Disposition: form-data; name="directory"\r\n\r\n`);
      append(`${directory}\r\n`);
      append(`--${boundary}--\r\n`);

      const finalBody = Buffer.concat(bodyParts);

      const headers = await getHeaders({
        "Content-Type": `multipart/form-data; boundary=${boundary}`
      });

      const resp = await fetch(FILE_UPLOAD_URL, {
        method: "POST",
        headers,
        body: finalBody
      });

      const json = await resp.json().catch(() => ({}));
      return res.json(json);
    }

    /* ------------------------------------------------
       checkinTask
       (Delivery / Pickup / Linehaul)
    ------------------------------------------------ */
    if (action === "checkinTask") {
      const { tripNo, taskNo, taskType, pro, uploadedFile } = req.body;

      if (!tripNo || !taskNo || !taskType) {
        return res.status(400).json({ error: "tripNo, taskNo, taskType required" });
      }

      const imageType = resolveImageType(taskType);

      const image_list = [];
      if (uploadedFile?.url && uploadedFile?.file_name) {
        image_list.push({
          image_type: imageType,
          image_url: uploadedFile.url,
          file_extension: uploadedFile.file_name.split(".").pop(),
          file_name: uploadedFile.file_name
        });
      }

      const payload = {
        trip_no: tripNo,
        task_no: taskNo,
        delivery_location: "",
        image_list,
        pro_number: pro || "",
        check_date: new Date().toISOString().slice(0, 19).replace("T", " ")
      };

      const resp = await fmsFetch(TASK_COMPLETE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const json = await resp.json().catch(() => ({}));
      return res.json({ ok: resp.ok, status: resp.status, response: json });
    }

    /* ------------------------------------------------
       cancelTask
       (Delivery / Pickup / Linehaul)
    ------------------------------------------------ */
    if (action === "cancelTask") {
      const { tripNo, taskNo, taskType } = req.body;

      if (!tripNo || !taskNo || !taskType) {
        return res.status(400).json({ error: "tripNo, taskNo, taskType required" });
      }

      // Linehaul special endpoint
      if (taskType.toLowerCase().includes("linehaul")) {
        const resp = await fmsFetch(LH_REVERT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ task_no: taskNo })
        });
        const json = await resp.json().catch(() => ({}));
        return res.json({ ok: resp.ok, status: resp.status, response: json });
      }

      // Delivery + Pickup use same cancel endpoint
      const url = `${TASK_CANCEL_URL}?tripNo=${tripNo}&taskNo=${taskNo}&stopNo=0`;

      const resp = await fmsFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });

      const json = await resp.json().catch(() => ({}));
      return res.json({ ok: resp.ok, status: resp.status, response: json });
    }

    /* ------------------------------------------------
       Unknown action
    ------------------------------------------------ */
    return res.status(400).json({ error: "Unknown action" });

  } catch (err) {
    console.error("🔥 FMS BOT ERROR:", err);
    return res.status(500).json({
      error: "Internal server error",
      message: err.message || String(err)
    });
  }
}
