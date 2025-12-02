console.log("fms.js loaded");

//-------------------------------------------------------------
// 1. REAL GET TRIP CALL (fallbacks to mock data)
//-------------------------------------------------------------
async function fetchTripTasks(tripNo) {
  console.log("Fetching trip:", tripNo);

  const url = `https://fms.item.com/fms-platform-order/driver-app/task/get-tasks/${tripNo}`;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json" }
    });

    if (!res.ok) throw new Error("API responded with " + res.status);

    const json = await res.json();

    console.log("API result:", json);

    return json.data || [];
  } catch (err) {
    console.warn("GET trip failed, using mock data:", err);

    return [
      {
        do: "251100011297",
        tracking_no: "50001344",
        pu_no: "7690654",
        task_type_text: "Delivery",
        status: "Complete",
        task_no: "T101"
      },
      {
        do: "250000332691",
        tracking_no: "",
        pu_no: "",
        task_type_text: "Linehaul",
        status: "New",
        task_no: "T104"
      }
    ];
  }
}

//-------------------------------------------------------------
// 2. Normalize FMS structure
//-------------------------------------------------------------
function normalizeTasks(raw) {
  console.log("Normalizing tasks…");

  return raw.map(t => ({
    do: t.order_no || t.do || "",
    tracking_pro: t.tracking_no || t.pro || "",
    pu_no: t.pu_no || "",
    taskType: t.task_type_text || "",
    status: t.status || "",
    taskNo: t.task_no || ""
  }));
}

//-------------------------------------------------------------
// 3. UI elements
//-------------------------------------------------------------
const loadBtn = document.getElementById("loadBtn");
const updateBtn = document.getElementById("updateBtn");
const output = document.getElementById("output");
const resultsBox = document.getElementById("resultsBox");

//-------------------------------------------------------------
// 4. Load Trip
//-------------------------------------------------------------
loadBtn.addEventListener("click", async () => {
  console.log("Load Trip clicked");

  const trip = document.getElementById("tripInput").value.trim();
  if (!trip) {
    alert("Enter a Trip #");
    return;
  }

  const raw = await fetchTripTasks(trip);
  const tasks = normalizeTasks(raw);

  renderTaskGroups(tasks);
});

//-------------------------------------------------------------
// 5. Render tasks grouped
//-------------------------------------------------------------
function renderTaskGroups(tasks) {
  console.log("Rendering", tasks.length, "tasks");

  output.innerHTML = "";

  const groups = {
    Delivery: [],
    Pickup: [],
    Linehaul: []
  };

  tasks.forEach(t => {
    if (t.taskType.includes("Delivery")) groups.Delivery.push(t);
    if (t.taskType.includes("Pickup") || t.taskType.includes("PU")) groups.Pickup.push(t);
    if (t.taskType.includes("Linehaul")) groups.Linehaul.push(t);
  });

  const sections = [
    { name: "Delivery Tasks", key: "Delivery" },
    { name: "PU(s)", key: "Pickup" },
    { name: "LH(s)", key: "Linehaul" }
  ];

  sections.forEach(sec => {
    const block = document.createElement("div");
    block.innerHTML = `<div class="section-title">${sec.name}</div>`;

    groups[sec.key].forEach(task => {
      const wrapper = document.createElement("div");
      wrapper.className = "taskItem";

      const isComplete = task.status?.toLowerCase() === "complete";

      wrapper.innerHTML = `
        <span class="taskLabel">
          DO ${task.do || "—"} | PRO ${task.tracking_pro || "—"} | PU ${task.pu_no || "—"}
        </span>

        <input type="checkbox"
          class="taskBox"
          data-old="${isComplete ? "1" : "0"}"
          data-taskNo="${task.taskNo}"
          data-do="${task.do}"
          data-pro="${task.tracking_pro}"
          data-pu="${task.pu_no}"
          data-type="${task.taskType}"
          ${isComplete ? "checked" : ""}
        />
      `;

      block.appendChild(wrapper);
    });

    output.appendChild(block);
  });
}

//-------------------------------------------------------------
// 6. Update button → returns TEST + results
//-------------------------------------------------------------
updateBtn.addEventListener("click", () => {
  console.log("Update clicked");

  const boxes = [...document.querySelectorAll(".taskBox")];
  let lines = [];

  boxes.forEach(box => {
    const oldVal = box.dataset.old === "1";
    const nowVal = box.checked;

    let action = "⏭ No Change";
    if (!oldVal && nowVal) action = "✅ Checked In";
    if (oldVal && !nowVal) action = "🔁 Check-In Reverted";

    lines.push(
      `${box.dataset.type}: DO ${box.dataset.do} | PRO ${box.dataset.pro || "—"} | PU ${box.dataset.pu || "—"} → ${action}`
    );
  });

  resultsBox.textContent = "TEST\n\n" + lines.join("\n");
});
