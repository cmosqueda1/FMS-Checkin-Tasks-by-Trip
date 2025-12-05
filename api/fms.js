/**
 * /api/fms.js
 * Trip Check-In Bot — Full Production Backend
 *
 * Includes:
 *  - Login + Token Cache
 *  - Get Tasks
 *  - Get Files for Trip
 *  - Upload File (multipart)
 *  - Delivery Check-in / Cancel
 *  - Pickup Check-in / Cancel
 *  - Linehaul Check-in / Cancel
 *  - File-to-task matching (Hybrid C)
 */

import Busboy from "busboy";

/* =====================================================
   CONFIG
=====================================================*/

const FMS_BASE = "https://fms.item.com";

// LOGIN
const LOGIN_URL = `${FMS_BASE}/fms-platform-user/Auth/Login`;

// TASK LIST
const TASK_LIST_URL =
  `${FMS_BASE}/fms-platform-dispatch-management/TripDetail/GetTaskList`;

// FILE LIST
const FILE_LIST_URL =
  `${FMS_BASE}/fms-platform-dispatch-management/Trips/GetFileInfoByTripId`;

// FILE UPLOAD
const FILE_UPLOAD_URL =
  `${FMS_BASE}/fms-platform-file/Storage/Upload`;

// DELIVERY / PICKUP / LINEHAUL CHECK-IN/CANCEL
const TASK_COMPLETE_URL =
  `${FMS_BASE}/fms-platform-dispatch-management/TripDetail/TaskComplete`;

const TASK_CANCEL_URL =
  `${FMS_BASE}/fms-platform-dispatch-management/TripDetail/TaskCompleteCancel`;

const LINEHAUL_REVERT_URL =
  `${FMS_BASE}/fms-platform-dispatch-management/lh/revert-arrived`;

// CONSTANTS
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

let FMS_TOKEN = null;   // small JWT
let AUTH_TOKEN = null;  // RSA token
let TOKEN_TS = 0;

const TOKEN_TTL = 55 * 60 * 1000;

/* =====================================================
   LOGIN
=====================================================*/

async function fmsLogin(force = false) {
  const now = Date.now();

  if (!force && FMS_TOKEN && AUTH_TOKEN && now - TOKEN_TS < TOKEN_TTL) {
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

  if (!resp.ok) throw new Error("FMS Login Failed");

  const json = await resp.json();
  const data = json?.data || {};

  FMS_TOKEN = data.token;
  AUTH_TOKEN = data.third_party_token || data.thirdPartyToken;

  if (!FMS_TOKEN || !AUTH_TOKEN)
    throw new Error("Login succeeded but tokens missing");

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
    "fms-client": FMS_CLIENT,
    "company-id": COMPANY_ID,
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
   TASK NORMALIZATION
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
   FILE MATCHING (Hybrid C)
=====================================================*/
/**
 * POD: match by taskNo first, fallback to PRO
 * BOL: match by PRO only
 */
function matchFileToTask(file, task) {
  const fileType = clean(file.file_type).toUpperCase();

  if (fileType === "POD") {
    if (String(file.task_no) === String(task.taskNo)) return true;
    if (clean(file.pro_no) === clean(task.pro)) return true;
    return false;
  }

  if (fileType === "BOL") {
    return clean(file.pro_no) === clean(task.pro);
  }

  // fallback if unknown
  return (
    String(file.task_no) === String(task.taskNo) ||
    clean(file.pro_no) === clean(task.pro)
  );
}

/* =====================================================
   PARSE MULTIPART (Busboy)
=====================================================*/

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });

    const files = [];
    const fields = {};

    busboy.on("file", (name, file, info) => {
      const chunks = [];
      file.on("data", (d) => chunks.push(d));
      file.on("end", () => {
        files.push({
          fieldname: name,
          filename: info.filename,
          mimeType: info.mimeType,
          buffer: Buffer.concat(chunks)
        });
      });
    });

    busboy.on("field", (name, val) => {
      fields[name] = val;
    });

    busboy.on("finish", () => resolve({ files, fields }));
    busboy.on("error", reject);

    req.pipe(busboy);
  });
}

/* =====================================================
   UPLOAD FILE TO FMS
=====================================================*/

async function uploadToFMS(fileBuffer, filename, mimeType, directory) {
  const form = new FormData();
  form.append("files", new Blob([fileBuffer], { type: mimeType }), filename);
  form.append("directory", directory);

  const headers = await getHeaders({});

  const resp = await fetch(FILE_UPLOAD_URL, {
    method: "POST",
    headers: {
      ...headers
      // DO NOT set Content-Type; FormData handles it
    },
    body: form
  });

  const json = await resp.json().catch(() => null);

  if (!json?.is_success) {
    throw new Error("FMS Upload Failed");
  }

  const item = json.data.items?.[0]?.file_info;

  return {
    fileName: item?.name,
    fileUrl: item?.url,
    extension: item?.file_extension
  };
}

/* =====================================================
   ACTION HANDLER
=====================================================*/

export const config = {
  api: {
    bodyParser: false // Required for file uploads
  }
};

export default async function handler(req, res) {
  try {
    if (req.method === "POST" && req.headers["content-type"]?.includes("multipart/form-data")) {
      // handle upload
      const { files, fields } = await parseMultipart(req);

      if (!files.length)
        return res.status(400).json({ error: "No file uploaded." });

      const f = files[0];
      const directory = fields.directory || "fms_trip_pod";

      const result = await uploadToFMS(
        f.buffer,
        f.filename,
        f.mimeType,
        directory
      );

      return res.json({
        success: true,
        ...result
      });
    }

    // JSON body
    const body = req.body || {};
    const { action } = body;

    /* =======================
       GET TASKS
    =======================*/
    if (action === "getTasks") {
      const tripNo = clean(body.tripNo);
      const url = `${TASK_LIST_URL}?tripNo=${encodeURIComponent(tripNo)}`;

      const resp = await fmsFetch(url, { method: "GET" });
      const json = await resp.json().catch(() => null);

      const raw = json?.data || [];
      const tasks = raw.map(normalizeTask);

      return res.json({ tripNo, tasks });
    }

    /* =======================
       GET FILES
    =======================*/
    if (action === "getFiles") {
      const tripNo = clean(body.tripNo);

      const resp = await fmsFetch(FILE_LIST_URL, {
        method: "POST",
        body: JSON.stringify({ trip_no: tripNo })
      });

      const json = await resp.json().catch(() => null);
      const files = json?.data?.files || [];

      return res.json({ tripNo, files });
    }

    /* =======================
       DELIVERY CHECKIN
    =======================*/
    if (action === "checkinDelivery") {
      const { tripNo, taskNo, imageList, pro } = body;

      const payload = {
        trip_no: tripNo,
        task_no: taskNo,
        delivery_location: "",
        image_list: imageList || [],
        pro_number: pro || "",
        check_date: new Date().toISOString().slice(0, 19).replace("T", " ")
      };

      const resp = await fmsFetch(TASK_COMPLETE_URL, {
        method: "POST",
        body: JSON.stringify(payload)
      });

      return res.json({ success: resp.ok });
    }

    /* =======================
       DELIVERY CANCEL
    =======================*/
    if (action === "undoDelivery") {
      const { tripNo, taskNo } = body;

      const url =
        `${TASK_CANCEL_URL}?tripNo=${encodeURIComponent(tripNo)}&taskNo=${taskNo}&stopNo=0`;

      const resp = await fmsFetch(url, { method: "POST", body: "{}" });

      return res.json({ success: resp.ok });
    }

    /* =======================
       PICKUP CHECKIN
    =======================*/
    if (action === "checkinPickup") {
      const { tripNo, taskNo, imageList } = body;

      const payload = {
        trip_no: tripNo,
        task_no: taskNo,
        delivery_location: "",
        image_list: imageList || []
      };

      const resp = await fmsFetch(TASK_COMPLETE_URL, {
        method: "POST",
        body: JSON.stringify(payload)
      });

      return res.json({ success: resp.ok });
    }

    /* =======================
       PICKUP CANCEL
    =======================*/
    if (action === "undoPickup") {
      const { tripNo, taskNo } = body;

      const url =
        `${TASK_CANCEL_URL}?tripNo=${encodeURIComponent(tripNo)}&taskNo=${taskNo}&stopNo=0`;

      const resp = await fmsFetch(url, { method: "POST", body: "{}" });

      return res.json({ success: resp.ok });
    }

    /* =======================
       LINEHAUL CHECKIN
    =======================*/
    if (action === "checkinLinehaul") {
      const { tripNo, taskNo } = body;

      const payload = {
        trip_no: tripNo,
        task_no: taskNo,
        delivery_location: "",
        image_list: []
      };

      const resp = await fmsFetch(TASK_COMPLETE_URL, {
        method: "POST",
        body: JSON.stringify(payload)
      });

      return res.json({ success: resp.ok });
    }

    /* =======================
       LINEHAUL CANCEL
    =======================*/
    if (action === "undoLinehaul") {
      const { taskNo } = body;

      const resp = await fmsFetch(LINEHAUL_REVERT_URL, {
        method: "POST",
        body: JSON.stringify({ task_no: taskNo })
      });

      return res.json({ success: resp.ok });
    }

    /* =======================
       UNKNOWN ACTION
    =======================*/
    return res.status(400).json({ error: "Unknown action" });

  } catch (err) {
    console.error("🔥 FMS BOT ERROR:", err);
    return res.status(500).json({
      error: "Internal server error",
      message: err.message || String(err)
    });
  }
}
