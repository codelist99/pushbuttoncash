const $ = (s) => document.querySelector(s),
  esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    ),
  money = (v) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(Number(v || 0)),
  integer = (v) => new Intl.NumberFormat("en-US").format(Number(v || 0)),
  pct = (a, b) => (b ? +((a / b) * 100).toFixed(1) : 0),
  date = (v) => (v ? new Date(v).toLocaleString() : "—"),
  empty = (n, t = "No records in this view") =>
    `<tr><td class="empty" colspan="${n}">${t}</td></tr>`;
let report,
  spendItems = [],
  leadsLocked = true,
  pages = { orders: 1, leads: 1, sales: 1 },
  page = { orders: 1, leads: 1, sales: 1 };
function range() {
  const end = new Date(),
    p = $("#preset").value;
  if (p === "custom") {
    const start = new Date($("#start").value),
      finish = new Date($("#end").value);
    if (Number.isNaN(start.valueOf()) || Number.isNaN(finish.valueOf()))
      throw Error("Choose a valid custom date range.");
    return { start: start.toISOString(), end: finish.toISOString() };
  }
  return {
    start: new Date(end - Number(p) * 3600000).toISOString(),
    end: end.toISOString(),
  };
}
async function api(url, options = {}) {
  const r = await fetch(url, {
    ...options,
    cache: "no-store",
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  if (!r.ok)
    throw Error(
      (await r.json().catch(() => ({}))).error ||
        "Reporting service unavailable",
    );
  return r.json();
}
const kpi = (l, v, h = "") =>
    `<div class="kpi"><div class="label">${l}</div><strong>${v}</strong><small>${h}</small></div>`,
  metric = (l, v) =>
    `<div class="metric-row"><span>${l}</span><strong>${v}</strong></div>`,
  alert = (t, h, b) =>
    `<div class="alert ${t}"><b>${h}</b><span>${b}</span></div>`;
function toast(m) {
  const n = $("#toast");
  n.textContent = m;
  n.classList.add("show");
  setTimeout(() => n.classList.remove("show"), 2200);
}
function renderOverview() {
  const s = report.summary,
    checkout = pct(s.checkout_visitors, s.visitors),
    lead = pct(s.leads, s.visitors),
    spend = Number(s.traffic_spend || 0),
    clicks = Number(s.ad_clicks || 0),
    impressions = Number(s.ad_impressions || 0),
    cpl = s.leads ? spend / s.leads : null,
    cpa = s.buyers ? spend / s.buyers : null,
    ctr = impressions ? pct(clicks, impressions) : null,
    conversionBase = clicks || s.visitors,
    conversionLabel = clicks ? "click" : "visitor",
    cvr = conversionBase ? pct(s.buyers, conversionBase) : 0,
    roas = spend ? s.revenue / spend : null,
    a = [];
  if (s.attempts && s.approval_rate < 50)
    a.push(
      alert(
        "danger",
        "Critical: payment approval rate below target",
        `${s.approval_rate}% of charge records are approved.`,
      ),
    );
  if (s.checkout_visitors && pct(s.payment_people, s.checkout_visitors) < 35)
    a.push(
      alert(
        "warn",
        "Checkout abandonment is elevated",
        `Only ${pct(s.payment_people, s.checkout_visitors)}% of checkout visitors have a payment record.`,
      ),
    );
  if (
    s.leads &&
    report.attribution.every((x) => x.source === "direct" && x.campaign === "—")
  )
    a.push(
      alert(
        "warn",
        "Campaign attribution is missing",
        "Add campaign identifiers to traffic links.",
      ),
    );
  if (!a.length)
    a.push(
      alert(
        "good",
        "Campaign systems are healthy",
        "No critical operational threshold is currently breached.",
      ),
    );
  $("#alerts").innerHTML = a.join("");
  $("#primary-kpis").innerHTML = [
    kpi(
      "Unique visitors",
      integer(s.visitors),
      `${integer(s.views)} page views`,
    ),
    kpi("Captured leads", integer(s.leads), `${lead}% visitor → lead`),
    kpi("Buyers", integer(s.buyers), `${s.conversion}% visitor conversion`),
    kpi("Gross revenue", money(s.revenue), `${money(s.net_revenue)} net`),
    kpi(
      "Approval rate",
      `${s.approval_rate}%`,
      `${s.approvals} of ${s.attempts} records`,
    ),
    kpi("CPL", cpl === null ? "—" : money(cpl), "Cost per captured lead"),
    kpi("CPA", cpa === null ? "—" : money(cpa), "Cost per buyer"),
    kpi("Clicks", integer(clicks), `${integer(impressions)} impressions`),
    kpi("CTR", ctr === null ? "—" : `${ctr}%`, "Clicks / impressions"),
    kpi("CVR", `${cvr}%`, `Buyer / ${conversionLabel} conversion`),
    kpi(
      "ROAS",
      roas === null ? "—" : `${roas.toFixed(2)}×`,
      "Revenue per ad dollar",
    ),
  ].join("");
  $("#economics").innerHTML =
    metric("Average order value", money(s.aov)) +
    metric("Revenue per visitor", money(s.rpv)) +
    metric("Revenue per lead", money(s.rpl)) +
    metric("Lead-to-buyer rate", `${s.lead_conversion}%`) +
    metric("Refunds", money(s.refunds));
  $("#quality").innerHTML =
    metric("VSL engagement", `${pct(s.video_engaged, s.visitors)}%`) +
    metric("Landing → checkout", `${checkout}%`) +
    metric(
      "Checkout → payment",
      `${pct(s.payment_people, s.checkout_visitors)}%`,
    ) +
    metric("Visitor → lead", `${lead}%`) +
    metric(
      "Views per visitor",
      s.visitors ? (s.views / s.visitors).toFixed(2) : "0",
    );
  $("#webinar-engagement").innerHTML =
    metric("Total button clicks", integer(s.step2_webinar_clicks)) +
    metric("Unique clickers", integer(s.step2_webinar_clickers)) +
    metric("Thank-you visitors", integer(s.thankyou_visitors)) +
    metric(
      "Click-through rate",
      `${pct(s.step2_webinar_clickers, s.thankyou_visitors)}%`,
    );
  renderTrend();
}
function renderTrend() {
  const data = report.trend;
  if (!data.length) {
    $("#trend").innerHTML =
      '<div class="empty">No trend data in this period</div>';
    return;
  }
  const w = 1000,
    h = 240,
    p = 30,
    max = Math.max(...data.map((x) => Number(x.views)), 1),
    pts = data.map((x, i) => ({
      x: p + (i * (w - p * 2)) / Math.max(data.length - 1, 1),
      y: h - p - (Number(x.views) / max) * (h - p * 2),
      ...x,
    })),
    line = pts.map((x) => `${x.x},${x.y}`).join(" "),
    area = `${p},${h - p} ${line} ${w - p},${h - p}`,
    labels = pts
      .filter(
        (_, i) =>
          i === 0 ||
          i === pts.length - 1 ||
          i % Math.ceil(pts.length / 6) === 0,
      )
      .map(
        (x) =>
          `<text class="chart-label" x="${x.x}" y="235" text-anchor="middle">${new Date(x.bucket).toLocaleTimeString([], { hour: "numeric" })}</text>`,
      )
      .join("");
  $("#trend").innerHTML =
    `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><defs><linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2563eb" stop-opacity=".25"/><stop offset="1" stop-color="#2563eb" stop-opacity="0"/></linearGradient></defs>${[40, 90, 140, 190].map((y) => `<line class="chart-grid" x1="30" x2="970" y1="${y}" y2="${y}"/>`).join("")}<polygon class="chart-area" points="${area}"/><polyline class="chart-line" points="${line}"/>${pts.map((x) => `<circle class="chart-point" cx="${x.x}" cy="${x.y}" r="3"><title>${x.views} views · ${x.leads} leads · ${money(x.revenue)}</title></circle>`).join("")}${labels}</svg>`;
}
function renderFunnel() {
  const s = report.summary,
    stages = [
      ["Visitors", s.visitors],
      ["VSL engaged", s.video_engaged],
      ["Checkout views", s.checkout_visitors],
      ["Checkout starts", s.checkout_started],
      ["Leads", s.leads],
      ["Payment people", s.payment_people],
      ["Buyers", s.buyers],
    ],
    base = Math.max(s.visitors, 1);
  $("#funnel-kpis").innerHTML = [
    kpi("VSL engagement", `${pct(s.video_engaged, s.visitors)}%`),
    kpi("Checkout reach", `${pct(s.checkout_visitors, s.visitors)}%`),
    kpi("Form completion", `${pct(s.leads, s.checkout_started)}%`),
    kpi("Payment intent", `${pct(s.payment_people, s.leads)}%`),
    kpi("Buyer conversion", `${s.conversion}%`),
  ].join("");
  $("#funnel-chart").innerHTML = stages
    .map(
      (x, i) =>
        `<div class="funnel-row"><b>${x[0]}</b><div class="funnel-track"><div class="funnel-fill" style="width:${Math.max((x[1] / base) * 100, 1)}%">${integer(x[1])}</div></div><div class="funnel-value">${pct(x[1], base)}%<small>${i ? pct(x[1], stages[i - 1][1]) + "% step" : "baseline"}</small></div></div>`,
    )
    .join("");
  const v = [
      ["Unmuted", s.video_engaged],
      ["25% watched", s.video_25],
      ["50% watched", s.video_50],
      ["75% watched", s.video_75],
      ["Completed", s.video_100],
    ],
    vb = Math.max(s.video_engaged, 1);
  $("#vsl-chart").innerHTML = v
    .map(
      (x) =>
        `<div><div class="bar-head"><b>${x[0]}</b><span>${integer(x[1])} <small>${pct(x[1], vb)}%</small></span></div><div class="bar-track"><div class="bar-fill" style="width:${(x[1] / vb) * 100}%"></div></div></div>`,
    )
    .join("");
  $("#routes-table").innerHTML =
    `<div class="table-scroll"><table><thead><tr><th>Page</th><th>Visitors</th><th>Views</th><th>Repeat</th></tr></thead><tbody>${report.routes.map((x) => `<tr><td>${esc(x.path)}</td><td>${x.visitors}</td><td>${x.views}</td><td>${x.visitors ? (x.views / x.visitors).toFixed(2) : 0}×</td></tr>`).join("") || empty(4)}</tbody></table></div>`;
  $("#devices").innerHTML =
    report.devices
      .map((x) =>
        metric(
          x.device,
          `${integer(x.visitors)} · ${pct(x.visitors, s.visitors)}%`,
        ),
      )
      .join("") ||
    '<div class="empty">Device capture begins with new traffic</div>';
}
function renderPayments() {
  const s = report.summary;
  $("#payment-kpis").innerHTML = [
    kpi("Attempts", integer(s.attempts), `${integer(s.payment_people)} people`),
    kpi("Approvals", integer(s.approvals), `${s.approval_rate}% approval`),
    kpi(
      "Declines",
      integer(s.declines),
      `${integer(s.declined_people)} people`,
    ),
    kpi(
      "System errors",
      integer(s.errors),
      s.errors ? "Action required" : "Stable",
    ),
    kpi("Approved revenue", money(s.revenue), `${money(s.refunds)} refunded`),
  ].join("");
  $("#responses").innerHTML =
    report.payments
      .map(
        (x) =>
          `<div class="response-card"><code>${esc(x.response_code)}</code><div><b>${esc(x.response)}</b><small>${esc(x.status)} · ${x.people} people · ${money(x.amount)}</small></div><strong>${x.attempts}</strong></div>`,
      )
      .join("") || '<div class="empty">No gateway activity</div>';
  $("#payment-health").innerHTML =
    `<div class="health-card ${s.errors ? "bad" : "good"}"><b>Gateway integration: ${s.errors ? "Errors detected" : "Operational"}</b><small>${s.errors} system errors in this window.</small></div><div class="health-card ${s.approval_rate < 50 ? "bad" : s.approval_rate < 70 ? "warn" : "good"}"><b>Issuer approval: ${s.approval_rate}%</b><small>${s.approval_rate < 50 ? "Investigate processor responses before scaling." : "Continue monitoring issuer decisions."}</small></div>`;
}
function renderOffers() {
  const s = report.summary,
    backend = report.offers
      .filter((x) => x.offer_key !== "front")
      .reduce((n, x) => n + Number(x.revenue), 0);
  $("#offer-kpis").innerHTML = [
    kpi("Active offers", report.offers.length),
    kpi("Offer revenue", money(s.revenue)),
    kpi("Overall approval", `${s.approval_rate}%`),
    kpi("Backend revenue", money(backend)),
    kpi("Average order value", money(s.aov)),
  ].join("");
  $("#offer-table").innerHTML = report.offers.length
    ? report.offers
        .map((x) => {
          const r = pct(x.approvals, x.attempts),
            state = !x.attempts ? "idle" : r < 50 ? "bad" : "";
          return `<tr><td><b>${esc(x.product_name)}</b><br><small>${esc(x.offer_key)}</small></td><td>${x.people}</td><td>${x.attempts}</td><td>${x.approvals}</td><td>${x.declines}</td><td>${r}%</td><td><b>${money(x.revenue)}</b></td><td><span class="dot ${state}"></span>${!x.attempts ? "No data" : r < 50 ? "Needs attention" : "Healthy"}</td></tr>`;
        })
        .join("")
    : empty(8);
}
function renderAcquisition() {
  const s = report.summary,
    tracked = report.attribution
      .filter((x) => x.source !== "direct" || x.campaign !== "—")
      .reduce((n, x) => n + Number(x.leads), 0),
    coverage = pct(tracked, s.leads);
  $("#acq-kpis").innerHTML = [
    kpi("Tracked leads", tracked),
    kpi("Attribution coverage", `${coverage}%`),
    kpi("Sources", new Set(report.attribution.map((x) => x.source)).size),
    kpi(
      "Campaigns",
      new Set(
        report.attribution
          .filter((x) => x.campaign !== "—")
          .map((x) => x.campaign),
      ).size,
    ),
    kpi("Lead conversion", `${s.lead_conversion}%`),
  ].join("");
  $("#attribution").innerHTML =
    `<div class="table-scroll"><table><thead><tr><th>Source</th><th>Campaign</th><th>Leads</th><th>Buyers</th><th>Conversion</th></tr></thead><tbody>${report.attribution.map((x) => `<tr><td>${esc(x.source)}</td><td>${esc(x.campaign)}</td><td>${x.leads}</td><td>${x.buyers}</td><td>${pct(x.buyers, x.leads)}%</td></tr>`).join("") || empty(5)}</tbody></table></div>`;
  $("#tracking-health").innerHTML =
    `<div class="health-card ${coverage < 50 ? "bad" : "good"}"><b>Attribution coverage: ${coverage}%</b><small>${coverage < 50 ? "Add utm_source, utm_campaign, aid and tid to every traffic link." : "Campaign links carry usable attribution."}</small></div><div class="health-card"><b>Recommended link format</b><small>?utm_source=email&utm_campaign=campaign_name&tid=list_segment</small></div>`;
}
async function loadOrders() {
  const r = range(),
    q = $("#order-search").value.trim(),
    d = await api(
      `/api/admin/orders?${new URLSearchParams({ ...r, page: page.orders, q })}`,
    );
  pages.orders = d.pagination.pages;
  page.orders = d.pagination.page;
  $("#orders-table").innerHTML = d.items.length
    ? d.items
        .map((o) => {
          const remaining = Math.max(
              0,
              Number(o.amount) - Number(o.refunded_amount || 0),
            ),
            action =
              o.status === "paid" && o.transaction_id && remaining > 0
                ? `<button class="refund-button" data-order="${Number(o.id)}" data-remaining="${remaining.toFixed(2)}">Refund</button>`
                : `<span class="refund-state">${esc(o.refund_status || "—")}</span>`;
          return `<tr><td><b>${esc([o.first_name, o.last_name].filter(Boolean).join(" ") || "Unknown")}</b></td><td>${esc(o.product_name)}</td><td>${money(o.amount)}${Number(o.refunded_amount) > 0 ? `<small class="refund-note">${money(o.refunded_amount)} returned</small>` : ""}</td><td><span class="badge ${esc(o.status)}">${esc(o.status)}</span></td><td class="response">${esc(o.response_code || "—")} · ${esc(o.response_message || "—")}</td><td>${esc(o.transaction_id || "—")}</td><td>${date(o.updated_at)}</td><td>${action}</td></tr>`;
        })
        .join("")
    : empty(8);
  pager("orders", d.pagination, "payment records");
}

$("#orders-table").onclick = async (e) => {
  const button = e.target.closest(".refund-button");
  if (!button) return;
  const remaining = Number(button.dataset.remaining),
    amountText = prompt(
      `Refund amount (maximum $${remaining.toFixed(2)}):`,
      remaining.toFixed(2),
    );
  if (amountText === null) return;
  const amount = Number(amountText);
  if (!Number.isFinite(amount) || amount <= 0 || amount > remaining) {
    toast("Enter a valid amount up to the remaining balance");
    return;
  }
  if (
    !confirm(
      `Process a $${amount.toFixed(2)} refund? This sends money through Authorize.Net.`,
    )
  )
    return;
  const pin = prompt("Enter admin PIN to confirm this refund:");
  if (pin === null) return;
  button.disabled = true;
  try {
    const result = await api("/api/admin/refunds", {
      method: "POST",
      body: JSON.stringify({
        orderId: Number(button.dataset.order),
        amount,
        pin,
      }),
    });
    toast(
      `${result.action === "void" ? "Void" : "Refund"} completed: ${money(result.amount)}`,
    );
    if (result.warning) alert(result.warning);
    await loadAll();
  } catch (error) {
    toast(error.message);
    alert(`Refund was not processed: ${error.message}`);
  } finally {
    button.disabled = false;
  }
};
async function loadLeads() {
  const d = await api(
    `/api/admin/leads?${new URLSearchParams({ page: page.leads, pageSize: 50, q: $("#lead-search").value.trim() })}`,
  );
  pages.leads = d.pagination.pages;
  page.leads = d.pagination.page;
  leadsLocked = Boolean(d.locked);
  $("#tab-leads").classList.toggle("lead-data-locked", Boolean(d.locked));
  $("#lead-lock").classList.toggle("unlocked", !d.locked);
  $("#leads-table").innerHTML = d.items.length
    ? d.items
        .map(
          (l) =>
            `<tr><td><b>${esc([l.first_name, l.last_name].filter(Boolean).join(" ") || "Unknown")}</b></td><td>${esc(l.email || "—")}</td><td>${esc(l.phone || "—")}</td><td><span class="badge ${l.display_status === "customer" ? "paid" : ""}">${esc(l.display_status)}</span></td><td>${esc(l.source || "—")}</td><td>${esc([l.utm_source, l.utm_campaign, l.aid && `AID ${l.aid}`, l.tid && `TID ${l.tid}`].filter(Boolean).join(" · ") || "—")}</td><td>${esc(l.landing_page || "—")}</td><td>${l.email_consent ? "Email " : ""}${l.sms_consent ? "SMS" : ""}</td><td>${date(l.created_at)}</td></tr>`,
        )
        .join("")
    : empty(9);
  pager("leads", d.pagination, "opt-ins");
}
async function loadSales() {
  const d = await api(
    `/api/admin/sales?${new URLSearchParams({ page: page.sales, q: $("#sale-search").value.trim() })}`,
  );
  pages.sales = d.pagination.pages;
  page.sales = d.pagination.page;
  $("#sales-table").innerHTML = d.items.length
    ? d.items
        .map((s) => {
          const canRefund = Number(s.refundable_count) > 0,
            contact = s.contact_hidden ? '<span class="protected-contact">Hidden</span>' : null;
          return `<tr><td><b>${esc([s.first_name, s.last_name].filter(Boolean).join(" ") || "Unknown")}</b><button class="refund-button buyer-refund-button" data-lead="${Number(s.id)}" ${canRefund ? "" : `disabled title="No refundable balance remains"`}>${canRefund ? "Refund" : "Refunded"}</button></td><td>${contact || esc(s.email || "—")}</td><td>${contact || esc(s.phone || "—")}</td><td>${s.purchase_count}</td><td class="response">${esc(s.products || "—")}</td><td>${money(s.gross_sales)}</td><td>${money(s.refund_amount)}${s.refund_count ? ` (${s.refund_count})` : ""}</td><td><b>${money(s.net_sales)}</b></td><td>${date(s.last_purchase_at)}</td></tr>`;
        })
        .join("")
    : empty(9);
  pager("sales", d.pagination, "sold leads");
}
async function processRefundButton(button, order) {
  const remaining = Math.max(
    0,
    Number(order.amount) - Number(order.refunded_amount || 0),
  );
  if (!remaining) return toast("This purchase has already been fully refunded");
  const amountText = prompt(
    `Refund amount for ${order.product_name} (maximum $${remaining.toFixed(2)}):`,
    remaining.toFixed(2),
  );
  if (amountText === null) return;
  const amount = Number(amountText);
  if (!Number.isFinite(amount) || amount <= 0 || amount > remaining) {
    toast("Enter a valid amount up to the remaining balance");
    return;
  }
  if (
    !confirm(
      `Process a $${amount.toFixed(2)} refund for ${order.product_name}? This sends money through Authorize.Net.`,
    )
  )
    return;
  const pin = prompt("Enter admin PIN to confirm this refund:");
  if (pin === null) return;
  button.disabled = true;
  try {
    const result = await api("/api/admin/refunds", {
      method: "POST",
      body: JSON.stringify({ orderId: Number(order.id), amount, pin }),
    });
    toast(
      `${result.action === "void" ? "Void" : "Refund"} completed: ${money(result.amount)}`,
    );
    if (result.warning) alert(result.warning);
    await loadAll();
  } catch (error) {
    toast(error.message);
    alert(`Refund was not processed: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}
$("#sales-table").onclick = async (e) => {
  const button = e.target.closest(".buyer-refund-button");
  if (!button) return;
  button.disabled = true;
  try {
    const data = await api(
        `/api/admin/buyer-orders?leadId=${encodeURIComponent(button.dataset.lead)}`,
      ),
      orders = data.items.filter(
        (o) =>
          o.transaction_id &&
          Number(o.amount) - Number(o.refunded_amount || 0) > 0,
      );
    if (!orders.length)
      return toast("No refundable purchases remain for this buyer");
    let selected = [orders[0]];
    if (orders.length > 1) {
      const menu = orders
          .map(
            (o, i) =>
              `${i + 1}. ${o.product_name} — ${money(Number(o.amount) - Number(o.refunded_amount || 0))} refundable`,
          )
          .join("\n"),
        choice = prompt(
          `Choose purchases to refund:\n${menu}\n\nEnter one number, multiple numbers like 1,2, or all:`,
          `1`,
        );
      if (choice === null) return;
      const value = choice.trim().toLowerCase(),
        indexes =
          value === "all"
            ? orders.map((_, i) => i)
            : [...new Set(value.split(",").map((x) => Number(x.trim()) - 1))];
      if (
        !indexes.length ||
        indexes.some((i) => !Number.isInteger(i) || !orders[i])
      )
        return toast("Enter a valid choice such as 1, 1,2, or all");
      selected = indexes.map((i) => orders[i]);
    }
    button.disabled = false;
    if (selected.length === 1) return processRefundButton(button, selected[0]);
    const refunds = selected.map((order) => ({
        order,
        amount: Math.max(
          0,
          Number(order.amount) - Number(order.refunded_amount || 0),
        ),
      })),
      total = refunds.reduce((sum, item) => sum + item.amount, 0);
    if (
      !confirm(
        `Refund ${refunds.length} purchases totaling ${money(total)}? Each transaction will be refunded in full through Authorize.Net.`,
      )
    )
      return;
    const pin = prompt("Enter admin PIN once to confirm all selected refunds:");
    if (pin === null) return;
    button.disabled = true;
    const results = [];
    for (const item of refunds) {
      try {
        const result = await api("/api/admin/refunds", {
          method: "POST",
          body: JSON.stringify({
            orderId: Number(item.order.id),
            amount: item.amount,
            pin,
          }),
        });
        results.push({
          ok: true,
          name: item.order.product_name,
          amount: result.amount,
        });
      } catch (error) {
        results.push({
          ok: false,
          name: item.order.product_name,
          error: error.message,
        });
      }
    }
    const failed = results.filter((x) => !x.ok),
      completed = results.filter((x) => x.ok);
    if (completed.length)
      toast(
        `${completed.length} refunds completed totaling ${money(completed.reduce((sum, x) => sum + Number(x.amount), 0))}`,
      );
    if (failed.length)
      alert(
        `Some refunds were not processed:\n${failed.map((x) => `${x.name}: ${x.error}`).join("\n")}`,
      );
    await loadAll();
  } catch (error) {
    toast(error.message);
    alert(`Could not load refundable purchases: ${error.message}`);
  } finally {
    button.disabled = false;
  }
};
async function loadProfitLogistics() {
  const d = await api("/api/admin/traffic-spend");
  spendItems = d.items || [];
  $("#profit-revenue").textContent = money(d.grossRevenue);
  $("#profit-refunds").textContent = money(d.refunds);
  $("#profit-chargebacks").textContent = money(d.chargebacks);
  $("#profit-spend").textContent = money(d.totalSpend);
  const total = $("#profit-total");
  total.textContent = money(d.profit);
  total.classList.toggle("negative", Number(d.profit) < 0);
  total.classList.toggle("positive", Number(d.profit) >= 0);
  $("#profit-equation").textContent =
    `${money(d.grossRevenue)} − ${money(d.refunds)} − ${money(d.chargebacks)} − ${money(d.totalSpend)} = ${money(d.profit)}`;
  $("#spend-rows").innerHTML = spendItems.length
    ? spendItems
        .map(
          (x) =>
            `<tr><td>${new Date(`${String(x.spend_date).slice(0, 10)}T00:00:00`).toLocaleDateString()}</td><td>${esc(x.source || "—")}</td><td>${integer(x.clicks)}</td><td>${integer(x.impressions)}</td><td>${esc(x.notes || "—")}</td><td><b>${money(x.amount)}</b></td><td><div class="spend-actions"><button type="button" class="edit-spend" data-id="${Number(x.id)}">Edit</button><button type="button" class="delete-spend" data-id="${Number(x.id)}">Delete</button></div></td></tr>`,
        )
        .join("")
    : empty(7, "No traffic spend has been entered yet");
  $("#refund-rows").innerHTML = d.refundItems.length
    ? d.refundItems
        .map(
          (x) =>
            `<tr><td>${date(x.updated_at)}</td><td>${esc([x.first_name, x.last_name].filter(Boolean).join(" ") || x.email || "Unknown")}</td><td>${esc(x.product_name || "—")}</td><td>${esc(x.action || "refund")}</td><td><b>${money(x.amount)}</b></td></tr>`,
        )
        .join("")
    : empty(5, "No refunds recorded");
  $("#chargeback-rows").innerHTML = d.chargebackItems.length
    ? d.chargebackItems
        .map(
          (x) =>
            `<tr><td>${date(x.occurred_at)}</td><td>${esc([x.first_name, x.last_name].filter(Boolean).join(" ") || x.email || "Unknown")}</td><td>${esc(x.product_name || "—")}</td><td>${esc(x.transaction_id || x.processor_case_id || "—")}</td><td><b>${money(x.amount)}</b></td></tr>`,
        )
        .join("")
    : empty(5, "No chargebacks recorded");
}
function pager(type, p, label) {
  $(`#${type}-foot`).textContent =
    `Page ${p.page} of ${p.pages} · ${integer(p.total)} ${label}`;
  $(`#${type}-prev`).disabled = p.page <= 1;
  $(`#${type}-next`).disabled = p.page >= p.pages;
}
async function loadAll() {
  const b = $("#refresh");
  b.disabled = true;
  $("#updated").textContent = "Synchronizing campaign data…";
  try {
    const r = range(),
      [rep, dash] = await Promise.all([
        api(`/api/admin/report?${new URLSearchParams(r)}`),
        api("/api/admin/dashboard"),
      ]);
    report = rep;
    renderOverview();
    renderFunnel();
    renderPayments();
    renderOffers();
    renderAcquisition();
    $("#automations").innerHTML =
      dash.automations
        .map(
          (a) =>
            `<p><span class="badge">${esc(a.channel)}</span> ${esc(a.name)} · ${a.delay_minutes}m · ${a.enabled ? "On" : "Off"}</p>`,
        )
        .join("") || '<p class="empty">No automations configured</p>';
    await Promise.all([
      loadOrders(),
      loadLeads(),
      loadSales(),
      loadProfitLogistics(),
    ]);
    $("#updated").textContent =
      `Updated ${new Date().toLocaleTimeString()} · ${date(rep.range.start)} to ${date(rep.range.end)}`;
    toast("Campaign data refreshed");
  } catch (e) {
    $("#updated").textContent = e.message;
    toast(e.message);
  } finally {
    b.disabled = false;
  }
}
$("#tabs").onclick = (e) => {
  const b = e.target.closest("[data-tab]");
  if (!b) return;
  document
    .querySelectorAll(".tabs button,.tabpage")
    .forEach((x) => x.classList.remove("active"));
  b.classList.add("active");
  $(`#tab-${b.dataset.tab}`).classList.add("active");
  history.replaceState({}, "", `#${b.dataset.tab}`);
};
$("#preset").onchange = () => {
  $("#custom").classList.toggle("hidden", $("#preset").value !== "custom");
  if ($("#preset").value !== "custom") {
    page.orders = 1;
    loadAll();
  }
};
$("#refresh").onclick = loadAll;
for (const t of ["orders", "leads", "sales"]) {
  $(`#${t}-prev`).onclick = () => {
    if (page[t] > 1) {
      page[t]--;
      ({ orders: loadOrders, leads: loadLeads, sales: loadSales })[t]();
    }
  };
  $(`#${t}-next`).onclick = () => {
    if (page[t] < pages[t]) {
      page[t]++;
      ({ orders: loadOrders, leads: loadLeads, sales: loadSales })[t]();
    }
  };
}
$("#order-search-button").onclick = () => {
  page.orders = 1;
  loadOrders();
};
$("#lead-search-button").onclick = () => {
  page.leads = 1;
  loadLeads();
};
$("#lead-unlock-button").onclick = async () => {
  const pin = prompt("Enter the four-digit lead access PIN:");
  if (pin === null) return;
  try {
    await api("/api/admin/leads/unlock", {
      method: "POST",
      body: JSON.stringify({ pin }),
    });
    await loadLeads();
    toast("Lead data unlocked for one hour");
  } catch (error) {
    toast(error.message);
  }
};
$("#lead-export").onclick = (event) => {
  if (!leadsLocked) return;
  event.preventDefault();
  toast("Unlock lead data before exporting");
};
$("#sale-search-button").onclick = () => {
  page.sales = 1;
  loadSales();
};
$("#lead-form").onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target),
    d = Object.fromEntries(f);
  d.email_consent = f.has("email_consent");
  d.sms_consent = f.has("sms_consent");
  await api("/api/admin/leads", { method: "POST", body: JSON.stringify(d) });
  e.target.reset();
  page.leads = 1;
  await loadAll();
};
$("#automation-form").onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target),
    d = Object.fromEntries(f);
  d.enabled = f.has("enabled");
  await api("/api/admin/automations", {
    method: "POST",
    body: JSON.stringify(d),
  });
  await loadAll();
};
document.querySelector(".mini-tabs").onclick = (e) => {
  const b = e.target.closest("[data-profit-tab]");
  if (!b) return;
  document
    .querySelectorAll("[data-profit-tab]")
    .forEach((x) => x.classList.toggle("active", x === b));
  document
    .querySelectorAll(".profit-view")
    .forEach((x) => x.classList.add("hidden"));
  $(
    `#profit-${b.dataset.profitTab === "overview" ? "overview" : `${b.dataset.profitTab}-tab`}`,
  ).classList.remove("hidden");
};
function resetSpendForm() {
  const form = $("#traffic-spend-form");
  form.elements.id.value = "";
  form.elements.amount.value = "";
  form.elements.clicks.value = "";
  form.elements.impressions.value = "";
  form.elements.source.value = "";
  form.elements.notes.value = "";
  form.elements.spend_date.value = local(new Date()).slice(0, 10);
  form.querySelector(".save-spend-button").textContent = "Save spend";
  form.querySelector(".cancel-spend-edit").classList.add("hidden");
}
$("#spend-rows").onclick = async (e) => {
  const edit = e.target.closest(".edit-spend"),
    remove = e.target.closest(".delete-spend"),
    button = edit || remove;
  if (!button) return;
  const item = spendItems.find(
    (x) => Number(x.id) === Number(button.dataset.id),
  );
  if (!item) return toast("Traffic spend entry is no longer available");
  if (edit) {
    const form = $("#traffic-spend-form");
    form.elements.id.value = item.id;
    form.elements.spend_date.value = String(item.spend_date).slice(0, 10);
    form.elements.amount.value = Number(item.amount).toFixed(2);
    form.elements.clicks.value = Number(item.clicks || 0);
    form.elements.impressions.value = Number(item.impressions || 0);
    form.elements.source.value = item.source || "";
    form.elements.notes.value = item.notes || "";
    form.querySelector(".save-spend-button").textContent = "Update spend";
    form.querySelector(".cancel-spend-edit").classList.remove("hidden");
    form.scrollIntoView({ behavior: "smooth", block: "nearest" });
    form.elements.amount.focus();
    return;
  }
  if (
    !confirm(
      `Delete the ${money(item.amount)} traffic spend entry from ${new Date(`${String(item.spend_date).slice(0, 10)}T00:00:00`).toLocaleDateString()}? This cannot be undone.`,
    )
  )
    return;
  button.disabled = true;
  try {
    await api(`/api/admin/traffic-spend/${item.id}`, { method: "DELETE" });
    if (Number($("#traffic-spend-form").elements.id.value) === Number(item.id))
      resetSpendForm();
    await loadProfitLogistics();
    toast("Traffic spend deleted");
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
};
$(".cancel-spend-edit").onclick = resetSpendForm;
$("#traffic-spend-form").onsubmit = async (e) => {
  e.preventDefault();
  const button = e.submitter;
  button.disabled = true;
  try {
    const f = new FormData(e.target),
      data = Object.fromEntries(f),
      id = Number(data.id) || 0;
    await api(
      id ? `/api/admin/traffic-spend/${id}` : "/api/admin/traffic-spend",
      { method: id ? "PUT" : "POST", body: JSON.stringify(data) },
    );
    resetSpendForm();
    await loadProfitLogistics();
    toast(id ? "Traffic spend updated" : "Traffic spend saved");
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
};
const now = new Date(),
  before = new Date(now - 86400000),
  local = (d) =>
    new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
$("#start").value = local(before);
$("#end").value = local(now);
$("#traffic-spend-form").elements.spend_date.value = local(now).slice(0, 10);
setInterval(
  () => ($("#clock").textContent = new Date().toLocaleTimeString()),
  1000,
);
const hash = location.hash.slice(1);
if (hash && $(`[data-tab="${hash}"]`)) $(`[data-tab="${hash}"]`).click();
loadAll();
setInterval(() => {
  if (!document.hidden) loadAll();
}, 60000);
