// fms.js

//-------------------------------------------------------------
// 1. REAL GET TRIP CALL (FMS) — update URL + tokens later
//-------------------------------------------------------------
async function fetchTripTasks(tripNo) {
  try {
    const url = `https://fms.item.com/fms-platform-order/driver-app/task/get-tasks/${tripNo}`;

    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer YOUR_TOKEN_HERE"
      }
    });

    const json = await res.json();

    // Expecting: { data: [ { task info } ]}
    return json.data || [];

  } catch (err) {
    console.error("GET Trip Error:", err);
    return [];
  }
}

//-------------------------------------------------------------
// 2. UI ELEMENTS
//-------------------------------------------------------------
const loadBtn = document.getElementById("loadBtn");
const updateBtn = document.getElementById("updateBtn");
const output = document.getElementById("output");
const resultsBox = document.getElementById("resultsBox");

//-------------------------------------------------------------
// 3. NORMALIZE FMS TASKS INTO OUR UNIFIED STRUCTURE
//-------------------------------------------------------------
function normalizeTasks(raw) {
  return raw.map(t => ({
    do: t.order_no || "",
    tracking_pro: t.tracking_no || "",
    pu_no: t.pu_no || "",
    taskType: t.task_type_text || "",
    status: t.status || "",
    taskNo: t.task_no || ""
  }));
}

//-------------------------------------------------------------
// 4. LOAD TRIP BUTTON
//-------------------------------------------------------------
loadBtn.addEventListener("click", async () => {
  const trip = document.getElementById("tripInput").value.trim();
  if (!trip) return alert("Enter a Trip # first");

  const raw = await fetchTripTasks(trip);
  const tasks = normalizeTasks(raw);

  renderTaskGroups(tasks);
});

//-------------------------------------------------------------
// 5. RENDER GROUPED TASKS WITH CHECKBOXES
//-------------------------------------------------------------
function renderTaskGroups(tasks) {
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
// 6. TEMP UPDATE LOGIC — RETURNS "TEST"
//-------------------------------------------------------------
updateBtn.addEventListener("click", () => {
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
