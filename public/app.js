let page = 1,
  mode = "login",
  user = JSON.parse(localStorage.getItem("parkwiseUser") || "null");
const $ = (s) => document.querySelector(s),
  escapeHtml = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (character) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
          character
        ],
    ),
  api = async (path, options = {}) => {
    const r = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    return d;
  };
const fmt = (t) =>
  new Date(t).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
let availableSpots = [];
function renderSpotOptions() {
  const vehicleType = $("#checkin [name=vehicle_type]").value;
  const spots = availableSpots.filter(
    (spot) => !spot.occupied && (vehicleType !== "ev" || spot.type === "ev"),
  );
  $("#spotSelect").innerHTML =
    spots
      .map(
        (s) =>
          `<option value="${s.id}">${escapeHtml(s.code)} · Level ${escapeHtml(s.level)} · ${escapeHtml(s.type)}${s.type === "ev" ? " · charger" : ""}</option>`,
      )
      .join("") || '<option value="">No matching spots available</option>';
}
async function availability() {
  const data = await api("/api/spots/availability");
  $("#availability").innerHTML = data
    .map(
      (x) =>
        `<article><p>${x.type === "ev" ? "EV charging" : x.type} spots</p><b>${x.available} <small>/ ${x.total} free</small></b></article>`,
    )
    .join("");
  const spots = await api("/api/spots");
  availableSpots = spots;
  renderSpotOptions();
}
async function rates() {
  const data = await api("/api/rates");
  $("#rates").innerHTML = `<div class="rate-row rate-head"><b>Type</b><b>First hour</b><b>Additional</b><b>Daily cap</b></div>${data
    .map(
      (rate) =>
        `<div class="rate-row"><span>${escapeHtml(rate.vehicle_type)}</span><span>₹${escapeHtml(rate.first_hour)}</span><span>₹${escapeHtml(rate.additional_hour)}</span><span>₹${escapeHtml(rate.daily_cap)}</span></div>`,
    )
    .join("")}`;
}
async function stays() {
  const q = encodeURIComponent($("#search").value);
  const d = await api(
    `/api/stays?q=${q}&status=${$("#status").value}&sort=${$("#sort").value}&page=${page}`,
  );
  $("#stays").innerHTML = d.data.length
    ? d.data
        .map(
          (x) =>
            `<div class="stay"><div><b>${escapeHtml(x.plate)}</b><small>${escapeHtml(x.driver_name)} · ${escapeHtml(x.vehicle_type)}</small></div><div><span class="tag">${escapeHtml(x.spot_code)}</span><small>Level ${escapeHtml(x.spot_level)} · ${escapeHtml(x.spot_type)}</small></div><div><small>${fmt(x.check_in)}</small>${x.check_out ? `<small>Out ${fmt(x.check_out)} · ₹${escapeHtml(x.fee)}</small>` : '<span class="tag">Parked now</span>'}</div>${x.check_out ? "" : `<div class="stay-actions"><button class="button checkout" data-id="${x.id}">Check out</button><button class="outline transfer" data-id="${x.id}">Transfer</button></div>`}</div>`,
        )
        .join("")
    : "<p>No stays match this search.</p>";
  $("#pageText").textContent =
    `Page ${d.page} of ${d.pages || 1} · ${d.total} stays`;
  $("#previous").disabled = page <= 1;
  $("#next").disabled = page >= d.pages;
  document.querySelectorAll(".checkout").forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          const x = await api(`/api/stays/${b.dataset.id}/check-out`, {
            method: "POST",
          });
          alert(
            `${x.plate} checked out. Fee: ₹${x.fee} for ${x.hours} hour(s).`,
          );
          load();
        } catch (e) {
          alert(e.message);
        }
      }),
  );
  document.querySelectorAll(".transfer").forEach(
    (button) =>
      (button.onclick = async () => {
        const plate = window.prompt("Transfer this stay to plate:");
        if (plate === null || !plate.trim()) return;
        try {
          const stay = await api(`/api/stays/${button.dataset.id}/transfer`, {
            method: "POST",
            body: JSON.stringify({ plate }),
          });
          alert(`${stay.plate} is now assigned to ${stay.spot_code}.`);
          load();
        } catch (e) {
          alert(e.message);
        }
      }),
  );
}
async function load() {
  try {
    await availability();
    await rates();
    await stays();
  } catch (e) {
    console.error(e);
  }
}
$("#rateForm").onsubmit = async (e) => {
  e.preventDefault();
  const msg = $("#rateMsg");
  try {
    const result = await api("/api/rates/import", {
      method: "POST",
      body: JSON.stringify({ text: $("#rateText").value }),
    });
    msg.textContent = `Imported ${result.imported.length} rate(s); rejected ${result.rejected.length} row(s).`;
    msg.className = "message success";
    await rates();
  } catch (error) {
    msg.textContent = error.message;
    msg.className = "message";
  }
};
$("#checkin").onsubmit = async (e) => {
  e.preventDefault();
  const msg = $("#checkinMsg"),
    data = Object.fromEntries(new FormData(e.target));
  data.spot_id = Number(data.spot_id);
  if (user) data.user_id = user.id;
  try {
    const x = await api("/api/stays/check-in", {
      method: "POST",
      body: JSON.stringify(data),
    });
    msg.textContent = `${x.plate} checked into ${x.spot_code}.`;
    msg.className = "message success";
    e.target.reset();
    page = 1;
    load();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = "message";
  }
};
$("#search").oninput = () => {
  page = 1;
  stays();
};
$("#status").onchange = () => {
  page = 1;
  stays();
};
$("#sort").onchange = () => {
  page = 1;
  stays();
};
$("#checkin [name=vehicle_type]").onchange = renderSpotOptions;
$("#previous").onclick = () => {
  page--;
  stays();
};
$("#next").onclick = () => {
  page++;
  stays();
};
$("#refresh").onclick = load;
const dialog = $("#auth");
$("#loginBtn").onclick = () => dialog.showModal();
$("#closeAuth").onclick = () => dialog.close();
$("#toggleAuth").onclick = () => {
  mode = mode === "login" ? "register" : "login";
  $("#toggleAuth").textContent =
    mode === "login"
      ? "New here? Create account"
      : "Already registered? Sign in";
  $("#authForm [name=name]").parentElement.style.display =
    mode === "login" ? "none" : "block";
  $("#authMsg").textContent = "";
};
$("#authForm").onsubmit = async (e) => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target));
  try {
    const result = await api(
      "/api/auth/" + (mode === "login" ? "login" : "register"),
      { method: "POST", body: JSON.stringify(d) },
    );
    user = result.user || result;
    localStorage.setItem("parkwiseUser", JSON.stringify(user));
    $("#loginBtn").textContent = `${user.name.split(" ")[0]} ✓`;
    dialog.close();
  } catch (err) {
    $("#authMsg").textContent = err.message;
  }
};
load();
