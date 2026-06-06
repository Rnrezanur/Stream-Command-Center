const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

const toast = $("#toast");
let toastTimer;
function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
}

let elapsed = (1 * 3600) + (42 * 60) + 18;
function formatTime(total) {
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}
setInterval(() => {
  elapsed += 1;
  $("#liveTimer").textContent = formatTime(elapsed);
  if ($("#recordButton").dataset.active === "true") {
    $("#recordSub").textContent = `Recording · ${formatTime(elapsed)}`;
  }
}, 1000);

$("#muteButton").addEventListener("click", (event) => {
  const button = event.currentTarget;
  const muted = button.dataset.muted === "true";
  button.dataset.muted = String(!muted);
  button.classList.toggle("danger", !muted);
  $("#muteLabel").textContent = muted ? "Mute microphone" : "Unmute microphone";
  showToast(muted ? "Microphone is live" : "Microphone muted");
});

$("#recordButton").addEventListener("click", (event) => {
  const button = event.currentTarget;
  const active = button.dataset.active === "true";
  button.dataset.active = String(!active);
  button.classList.toggle("recording", !active);
  $(".record-square").style.background = active ? "#879099" : "#ff4d58";
  $("#recordLabel").textContent = active ? "Start recording" : "Stop recording";
  $("#recordSub").textContent = active ? "Ready to record" : `Recording · ${formatTime(elapsed)}`;
  showToast(active ? "Recording saved" : "Recording started");
});

const stopModal = $("#stopModal");
$("#streamButton").addEventListener("click", () => {
  if ($("#streamButton").dataset.active === "true") {
    stopModal.classList.add("open");
    stopModal.setAttribute("aria-hidden", "false");
  } else {
    startStream();
  }
});
$("#cancelStop").addEventListener("click", closeModal);
stopModal.addEventListener("click", (event) => { if (event.target === stopModal) closeModal(); });
function closeModal() {
  stopModal.classList.remove("open");
  stopModal.setAttribute("aria-hidden", "true");
}
$("#confirmStop").addEventListener("click", () => {
  const button = $("#streamButton");
  button.dataset.active = "false";
  button.classList.remove("danger");
  $("#streamButtonLabel").textContent = "Start stream";
  $(".status-label").textContent = "Broadcast offline";
  $(".status-light").style.background = "#68717a";
  $(".broadcast-status").querySelector(".quality").textContent = "Ready";
  $$(".platform-name span").forEach((el) => el.innerHTML = "<i style='background:#68717a'></i> Offline");
  closeModal();
  showToast("Stream ended on all platforms");
});
function startStream() {
  const button = $("#streamButton");
  button.dataset.active = "true";
  button.classList.add("danger");
  $("#streamButtonLabel").textContent = "Stop stream";
  $(".status-label").textContent = "Broadcast live";
  $(".status-light").style.background = "#ff4d58";
  $(".broadcast-status").querySelector(".quality").textContent = "1080p · 60fps";
  $$(".platform-name span").forEach((el) => el.innerHTML = "<i></i> Live · Excellent");
  showToast("Live on 4 platforms");
}

$("#sceneGrid").addEventListener("click", (event) => {
  const card = event.target.closest(".scene-card");
  if (!card) return;
  $$(".scene-card").forEach((scene) => {
    scene.classList.remove("active");
    const hint = scene.querySelector("small");
    if (hint.textContent === "LIVE") hint.textContent = `⌘ ${$$(".scene-card").indexOf(scene) + 1}`;
  });
  card.classList.add("active");
  card.querySelector("small").textContent = "LIVE";
  showToast(`Scene changed to ${card.dataset.scene}`);
});
$("#addScene").addEventListener("click", () => showToast("Scene creator opened"));

$("#chatFilters").addEventListener("click", (event) => {
  const filterButton = event.target.closest("button");
  if (!filterButton) return;
  $$("#chatFilters button").forEach((button) => button.classList.remove("active"));
  filterButton.classList.add("active");
  const filter = filterButton.dataset.filter;
  $$(".comment").forEach((comment) => comment.classList.toggle("hidden", filter !== "all" && comment.dataset.platform !== filter));
});

$("#chatForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("#chatInput");
  if (!input.value.trim()) return;
  const comment = document.createElement("article");
  comment.className = "comment";
  comment.dataset.platform = "all";
  comment.innerHTML = `<div class="comment-avatar green">RS</div><div><div class="comment-meta"><strong>Relay Studio</strong><span class="tag tiktok-tag">All</span><time>now</time></div><p></p></div>`;
  comment.querySelector("p").textContent = input.value.trim();
  $("#chatFeed").prepend(comment);
  input.value = "";
  showToast("Message sent to all platforms");
});

$$(".reply-action").forEach((button) => button.addEventListener("click", () => {
  $("#chatInput").focus();
  $("#chatInput").placeholder = "Reply to Alex Rivera...";
}));

document.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() === "m" && document.activeElement.tagName !== "INPUT") $("#muteButton").click();
  if (event.metaKey && event.key.toLowerCase() === "r") { event.preventDefault(); $("#recordButton").click(); }
  if (event.metaKey && event.key.toLowerCase() === "s") { event.preventDefault(); $("#streamButton").click(); }
  if (event.metaKey && ["1","2","3","4"].includes(event.key)) { event.preventDefault(); $$(".scene-card")[Number(event.key) - 1].click(); }
});
