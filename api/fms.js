// /api/fms.js
// Single serverless router for ALL Trip Check-In Bot backend actions

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body || {};
  const { action } = body;

  if (!action) {
    return res.status(400).json({ error: "Missing action" });
  }

  try {
    switch (action) {

      // =====================================================
      // 1) FETCH FMS TRIP TASKS
      // =====================================================
      case "getTasks": {
        const { tripNo } = body;
        if (!tripNo) {
          return res.status(400).json({ error: "tripNo required" });
        }

        const url =
          "https://fms.item.com/fms-platform-dispatch-management/TripDetail/GetTaskList?tripNo=" +
          encodeURIComponent(tripNo);

        const fmsResp = await fetch(url, {
          method: "GET",
          headers: { "Content-Type": "application/json" },
        });

        if (!fmsResp.ok) {
          return res.status(500).json({
            error: "FMS request failed",
            details: await fmsResp.text(),
          });
        }

        const data = await fmsResp.json();
        const raw = data?.tasks || data || [];

        const clean = (v) => (v == null ? "" : String(v).trim());

        const normalize = (t) => {
          const status = clean(t.status_text || t.status);
          const typeRaw = clean(t.task_type_text || t.taskType || "");

          let taskType = "";
          const l = typeRaw.toLowerCase();
          if (l.includes("delivery")) taskType = "Delivery";
          else if (l.includes("pickup")) taskType = "Pickup";
          else if (l.includes("linehaul") || l.includes("transfer"))
            taskType = "Linehaul";
          else taskType = typeRaw || "Other";

          return {
            do: clean(t.order_no || t.do),
            pro: clean(t.tracking_no || t.pro),
            pu: clean(t.pu_no || t.reference5 || t.pu),
            taskNo: t.task_no || t.taskNo || 0,
            taskType,
            status,
          };
        };

        const normalized = raw.map((x) => normalize(x));

        return res.status(200).json({
          tripNo,
          tasks: normalized,
        });
      }

      // =====================================================
      // 2) APPLY CHECK-IN
      // =====================================================
      case "checkin": {
        const { tripNo, task } = body;
        if (!tripNo || !task) {
          return res.status(400).json({
            error: "tripNo and task required",
          });
        }

        // Replace URL with final Check-In endpoint
        const checkUrl =
          "https://fms.item.com/fms-platform-dispatch-management/TripDetail/TaskCheckIn";

        const resp = await fetch(checkUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tripNo,
            taskNo: task.taskNo,
          }),
        });

        return res.status(200).json({
          success: resp.ok,
          tripNo,
          taskNo: task.taskNo,
        });
      }

      // =====================================================
      // 3) APPLY UNDO CHECK-IN
      // =====================================================
      case "undo": {
        const { tripNo, task } = body;
        if (!tripNo || !task) {
          return res.status(400).json({
            error: "tripNo and task required",
          });
        }

        // Replace URL with final Undo endpoint
        const undoUrl =
          "https://fms.item.com/fms-platform-dispatch-management/TripDetail/CancelTaskCheckIn";

        const resp = await fetch(undoUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tripNo,
            taskNo: task.taskNo,
          }),
        });

        return res.status(200).json({
          success: resp.ok,
          tripNo,
          taskNo: task.taskNo,
        });
      }

      // =====================================================
      // INVALID ACTION
      // =====================================================
      default:
        return res.status(400).json({ error: "Unknown action: " + action });
    }
  } catch (err) {
    console.error("FMS router error:", err);
    res.status(500).json({
      error: "Internal Server Error",
      details: String(err),
    });
  }
}
