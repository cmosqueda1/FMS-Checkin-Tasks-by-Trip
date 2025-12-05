// /api/fms.js
//
// ✅ PRODUCTION VERSION
// - Correct FMS checkin/undo APIs (TaskComplete / TaskCompleteCancel / lh/revert-arrived)
// - Trip file lookup added
// - File requirement validation added (BOL for Pickup, POD for Delivery)
// - Legacy test APIs removed
// - Compatible with your existing frontend

/* =====================================================
   CONFIG
=====================================================*/

const FMS_BASE = "https://fms.item.com";

// Correct live API endpoints
const LOGIN_URL =
  `${FMS_BASE}/fms-platform-user/Auth/Login`;

const TASKS_URL =
  `${FMS_BASE}/fms-platform-dispatch-management/TripDetail/GetTaskList`;

const FILES_URL =
  `${FMS_BASE}/fms-platform-dispatch-management/Trips/GetFileInfoByTripId`;

const TASK_COMPLETE_URL =
  `${FMS_BASE}/fms-platform-dispatch-management/TripDetail/TaskComplete`;

const TASK_UNDO_URL =
  `${FMS_BASE}/fms-platform-dispatch-management/TripDetail/TaskCompleteCancel`;

const LH_REVERT_URL =
  `${FMS_BASE}/fms-platform-dispatch-management/lh/revert-arrived`;

const UPLOAD_URL =
  `${FMS_BASE}/fms-platform-file/Storage/Upload`;


const FMS_CLIENT = "FMS_WEB";
const COMPANY_ID = "SBFH";

/* =====================================================
   ENV VARS
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
    return { fmsToken: FMS_TOKEN, authToken: AUTH_TOKEN };
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

  const json = await resp.json();
  const data = json?.data || {};

  FMS_TOKEN = data.token;
  AUTH_TOKEN = data.third_party_token || data.thirdPartyToken;
  TOKEN_TS = now;

  return { fmsToken: FMS_TOKEN, authToken: AUTH_TOKEN };
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
   FETCH WRAPPER W/ REAUTH
=====================================================*/

async function fmsFetch(url, options = {}, retry = 0) {

  const resp = await fetch(url, {
    ...options,
    headers: await getHeaders(options.headers || {})
  });

  if ((resp.status === 401 || resp.status === 403) && retry < 1) {
    await fmsLogin(true);
    return fmsFetch(url, options, retry + 1);
  }

  return resp;
}

/* =====================================================
   TASK NORMALIZATION
=====================================================*/

const clean = (v) => String(v ?? "").trim();

function normalizeTask(t) {
  return {
    do: clean(t.order_no),
    pro: clean(t.tracking_no),
    pu: clean(t.pu_no),
    taskNo: Number(t.task_no),
    type: clean(t.task_type_text),     // Pickup, Delivery, Linehaul
    status: clean(t.status_text),
    complete: clean(t.status_text).toLowerCase() === "complete"
  };
}

/* =====================================================
   FILE LOOKUP HELPERS
=====================================================*/

async function getTripFiles(tripNo) {
  const resp = await fmsFetch(FILES_URL, {
    method: "POST",
    body: JSON.stringify({ trip_no: tripNo })
  });
  const json = await resp.json();
  return json?.data?.files || [];
}

function fileForTask(task, files) {
  return files.find(f => f.pro_no === task.pro);
}

function taskNeedsFile(task) {
  if (task.type === "Pickup") return "BOL";
  if (task.type === "Delivery") return "POD";
  return null;
}

/* =====================================================
   FILE UPLOAD (POD/BOL)
=====================================================*/

async function uploadFile(fileData, directory) {

  const form = new FormData();
  form.append("files", fileData.blob, fileData.filename);
  form.append("directory", directory);

  const resp = await fetch(UPLOAD_URL, {
    method: "POST",
    headers: await getHeaders({}) // DO NOT set content-type
    ,
    body: form
  });

  const json = await resp.json();
  return json?.data?.items?.[0]?.file_info || null;
}

/* =====================================================
   MAIN HANDLER
=====================================================*/

export default async function handler(req, res) {

  try {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });

    const { action, tripNo, task, fileData } = req.body || {};

    /* ----------------------------------------------------
       GET TASKS
    -----------------------------------------------------*/
    if (action === "getTasks") {

      const url = `${TASKS_URL}?tripNo=${encodeURIComponent(tripNo)}`;
      const resp = await fmsFetch(url, { method: "GET" });
      const json = await resp.json();

      const tasks = (json?.data || []).map(normalizeTask);

      const files = await getTripFiles(tripNo);

      return res.json({
        tripNo,
        count: tasks.length,
        tasks,
        files
      });
    }

    /* ----------------------------------------------------
       CHECK-IN (Pickup / Delivery / Linehaul)
    -----------------------------------------------------*/
    if (action === "checkin") {

      const files = await getTripFiles(tripNo);
      const existingFile = fileForTask(task, files);

      const needed = taskNeedsFile(task);

      let image_list = [];

      // Requires POD or BOL?
      if (needed) {
        if (existingFile) {
          // FILE ALREADY EXISTS
          image_list = [{
            image_type: needed,
            image_url: existingFile.file_public_url,
            file_extension: existingFile.file_category,
            file_name: existingFile.file_id
          }];
        } else {
          // Must upload file first
          if (!fileData)
            return res.status(400).json({
              error: `${needed} required`,
              missing: needed
            });

          const uploaded = await uploadFile(fileData, needed === "POD" ? "fms_trip_pod" : "fms_trip_bol");

          image_list = [{
            image_type: needed,
            image_url: uploaded.url,
            file_extension: uploaded.name.split(".").pop(),
            file_name: uploaded.name
          }];
        }
      }

      // --- Send correct check-in payload ---
      const body = {
        trip_no: tripNo,
        task_no: task.taskNo,
        delivery_location: "",
        image_list,
        pro_number: task.pro,
        check_date: new Date().toISOString().slice(0,19).replace("T"," ")
      };

      const resp = await fmsFetch(TASK_COMPLETE_URL, {
        method: "POST",
        body: JSON.stringify(body)
      });

      const json = await resp.json().catch(() => null);

      return res.json({
        success: resp.ok,
        status: resp.status,
        taskNo: task.taskNo,
        response: json
      });
    }

    /* ----------------------------------------------------
       UNDO CHECK-IN
    -----------------------------------------------------*/
    if (action === "undo") {

      if (task.type === "Linehaul") {
        // Linehaul uses special endpoint
        const resp = await fmsFetch(LH_REVERT_URL, {
          method: "POST",
          body: JSON.stringify({ task_no: task.taskNo })
        });
        const json = await resp.json();
        return res.json({ success: resp.ok, response: json });
      }

      // Pickup & Delivery use TaskCompleteCancel
      const url =
        `${TASK_UNDO_URL}?tripNo=${tripNo}&taskNo=${task.taskNo}&stopNo=0`;

      const resp = await fmsFetch(url, {
        method: "POST",
        body: "{}"
      });

      const json = await resp.json();
      return res.json({
        success: resp.ok,
        taskNo: task.taskNo,
        response: json
      });
    }

    /* ----------------------------------------------------
       UNKNOWN ACTION
    -----------------------------------------------------*/
    return res.status(400).json({ error: "Unknown action" });

  } catch (err) {
    console.error("🔥 FMS BOT ERROR:", err);
    return res.status(500).json({
      error: "Internal server error",
      message: err.message
    });
  }
}
