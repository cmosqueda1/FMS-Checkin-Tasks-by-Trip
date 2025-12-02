export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "POST only" });

  const { action } = req.body;

  // ====================================
  // GET TRIP TASKS
  // ====================================
  if (action === "getTasks") {
    const { trip } = req.body;

    try {
      const url = `https://fms.item.com/fms-platform-order/driver-app/task/get-tasks/${trip}`;

      const fmsRes = await fetch(url, {
        method: "GET",
        headers: { "Content-Type": "application/json" }
      });

      const json = await fmsRes.json();

      const tasks = (json.data || []).map(t => ({
        do: t.order_no || "",
        pro: t.tracking_no || "",
        pu: t.pu_no || "",
        complete: t.status === "Complete",
        taskNo: t.task_no
      }));

      return res.status(200).json({ tasks });

    } catch (err) {
      return res.status(500).json({ error: "FMS GET failed", details: err.message });
    }
  }

  // ====================================
  // UPDATE TASKS (TEMP: return TEST)
  // ====================================
  if (action === "update") {
    return res.status(200).json({
      result: "TEST"
    });
  }

  // ====================================
  // UNKNOWN ACTION
  // ====================================
  return res.status(400).json({ error: "Invalid action" });
}
