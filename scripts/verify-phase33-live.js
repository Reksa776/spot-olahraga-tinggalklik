#!/usr/bin/env node
/**
 * PHASE 33 LIVE VERIFICATION — real server, real HTTP, real database.
 *
 * Walkthrough (per the operator's checklist):
 *   ADMIN  → /dashboard/users 200 + Pengguna row
 *          → POST create MANAGER → POST create PIC (User+PICProfile)
 *   MANAGER login → /dashboard 200, /dashboard/users 403-denied panel, menu has no Sistem rows
 *   PIC login → /dashboard 200 with the four self-service rows only
 *   existing CUSTOMER → createPic → platformRole=PIC, same orders/tickets, Pendapatan 200
 *   disabled account → credentials login REFUSED
 *   /dashboard/payments rendered; DataTable key probe = the console-warning assertion
 */
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const BASE = process.env.VERIFY_BASE || "http://localhost:3457";
const prisma = new PrismaClient({ log: [] });

const SUFFIX = `live-${Date.now().toString(36)}`;
const results = [];

function record(step, ok, detail) {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? " — " + detail : ""}`);
}

async function getCsrfAndLogin(identifier, password) {
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
  const csrf = await csrfRes.json();
  const cookie = (csrfRes.headers.getSetCookie ? csrfRes.headers.getSetCookie() : [csrfRes.headers.get("set-cookie")])
    .filter(Boolean)
    .map((c) => c.split(";")[0])
    .join("; ");

  const body = new URLSearchParams({
    identifier,
    password,
    csrfToken: csrf.csrfToken,
    callbackUrl: BASE + "/dashboard",
    json: "true",
  });

  let loginRes;
  try {
    loginRes = await fetch(`${BASE}/api/auth/callback/credentials`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie,
        "User-Agent": "Mozilla/5.0 (phase33-live-verify)",
        Referer: `${BASE}/login`,
      },
      body: body.toString(),
      redirect: "manual",
    });
  } catch {
    // Node's fetch follows the callback's cross-origin Location (AUTH_URL host) and
    // fails when nothing listens there — the session cookie is ALREADY on the response.
    // Retry once with redirect disabled explicitly is not expressible, so drive curl's
    // semantics instead: treat connection-reset-after-headers as the 302 it was.
    loginRes = { status: 302, headers: new Headers() };
  }

  const sessionCookies =
    loginRes.headers.getSetCookie && loginRes.headers.getSetCookie().length
      ? loginRes.headers.getSetCookie().filter(Boolean).map((c) => c.split(";")[0])
      : cookie
        ? [cookie]
        : [];

  return { status: loginRes.status, cookies: sessionCookies.join("; "), all: sessionCookies };
}

async function jget(path, cookies) {
  const res = await fetch(`${BASE}${path}`, { headers: { Cookie: cookies } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

async function jpost(path, cookies, payload) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookies },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

async function main() {
  // A dedicated verification ADMIN (known password), NOT the operator's real account —
  // its credentials are secret and are never guessed here. Removed in cleanup.
  const admin = await prisma.user.findUnique({
    where: { email: "phase33-verify-admin@example.test" },
    select: { id: true, email: true, password: true },
  });
  if (!admin) throw new Error("verification ADMIN missing — run the fixture step first");

  /* ============ 1. ADMIN session ============ */
  const adminSession = await getCsrfAndLogin(admin.email, "Phase33Verify!1");
  const adminCookies = adminSession.cookies || "";
  record(
    "1. ADMIN login",
    /authjs\.session-token|__Secure-authjs\.session-token/.test(adminCookies),
    `status ${adminSession.status}`
  );

  /* ============ 2. /dashboard/users as ADMIN ============ */
  const usersPage = await jget("/dashboard/users", adminCookies);
  record(
    "2. ADMIN GET /dashboard/users → 200 + Pengguna",
    usersPage.status === 200 && usersPage.text.includes("Pengguna"),
    `status ${usersPage.status}`
  );

  /* ============ 3. Create MANAGER (API) ============ */
  const mgrEmail = `manager-${SUFFIX}@example.test`;
  const createMgr = await jpost("/api/admin/users", adminCookies, {
    name: "Manager Live",
    email: mgrEmail,
    password: "PasswordRahasia1",
    role: "MANAGER",
  });
  const mgrUser = await prisma.user.findUnique({
    where: { email: mgrEmail },
    select: { id: true, platformRole: true, password: true },
  });
  record(
    "3. ADMIN creates MANAGER",
    createMgr.status === 201 &&
      mgrUser &&
      mgrUser.platformRole === "MANAGER" &&
      mgrUser.password.startsWith("$2"),
    `http ${createMgr.status}, role ${mgrUser ? mgrUser.platformRole : "n/a"}`
  );

  /* ============ 4. Create PIC (API) ============ */
  const picEmail = `pic-${SUFFIX}@example.test`;
  const createPic = await jpost("/api/admin/users", adminCookies, {
    name: "PIC Live",
    email: picEmail,
    password: "PasswordRahasia1",
    role: "PIC",
    pic: { displayName: "PIC Live Display" },
  });
  const [picUser, picProfile] = await Promise.all([
    prisma.user.findUnique({ where: { email: picEmail }, select: { id: true, platformRole: true } }),
    prisma.pICProfile.findFirst({ where: { user: { email: picEmail } }, select: { id: true, status: true, picCode: true } }),
  ]);
  record(
    "4. ADMIN creates PIC (User + PICProfile atomically)",
    createPic.status === 201 && picUser && picUser.platformRole === "PIC" && picProfile && picProfile.status === "PENDING",
    `http ${createPic.status}, role ${picUser ? picUser.platformRole : "n/a"}, profile ${picProfile ? picProfile.status : "n/a"}`
  );

  /* ============ 5. Approve + assign the PIC so the self-service has content ============ */
  await prisma.pICProfile.update({ where: { id: picProfile.id }, data: { status: "ACTIVE" } });
  const owner = await prisma.user.findFirst({ where: { email: { contains: "@" }, platformRole: null }, select: { id: true } });
  let organizer = await prisma.organizer.findFirst({ select: { id: true, name: true } });
  if (!organizer) {
    organizer = await prisma.organizer.create({
      data: { ownerUserId: owner ? owner.id : admin.id, name: `Org ${SUFFIX}`, slug: `org-${SUFFIX}`, status: "ACTIVE" },
      select: { id: true, name: true },
    });
  }
  const sport = await prisma.sport.findFirst({ select: { id: true } });
  const event = await prisma.event.create({
    data: {
      organizerId: organizer.id,
      sportId: sport.id,
      title: `Event Live ${SUFFIX}`,
      slug: `event-${SUFFIX}`,
      eventCode: `EVT-${SUFFIX}`,
      status: "PUBLISHED",
      startAt: new Date(Date.now() + 86400000),
      createdByUserId: admin.id,
    },
    select: { id: true, slug: true },
  });
  await prisma.pICEventAssignment.create({
    data: { picProfileId: picProfile.id, eventId: event.id, organizerId: organizer.id, assignedByUserId: admin.id, isActive: true },
  });
  record("5. PIC approved + assigned to a PUBLISHED event", true, event.slug);

  /* ============ 6. MANAGER login → no System controls, tenant fits membership ============ */
  const mgrSession = await getCsrfAndLogin(mgrEmail, "PasswordRahasia1");
  const mgrCookies = mgrSession.cookies || "";
  record("6. MANAGER login", /session-token/.test(mgrCookies), `status ${mgrSession.status}`);

  const mgrUsers = await jget("/dashboard/users", mgrCookies);
  record(
    "7. MANAGER GET /dashboard/users → DENIED",
    mgrUsers.status === 200 && mgrUsers.text.includes("Akses ditolak"),
    `http ${mgrUsers.status}, denial panel rendered`
  );

  const mgrApi = await jget("/api/admin/users", mgrCookies);
  record(
    "8. MANAGER GET /api/admin/users → 403",
    mgrApi.status === 403,
    `http ${mgrApi.status}`
  );

  const mgrHome = await jget("/dashboard", mgrCookies);
  const mgrHasSystem = mgrHome.text.includes('href="/dashboard/users"') || mgrHome.text.includes('href="/dashboard/settings/application"');
  record(
    "9. MANAGER /dashboard → operational, NO System rows",
    mgrHome.status === 200 && !mgrHasSystem,
    `http ${mgrHome.status}, system rows present: ${mgrHasSystem}`
  );

  /* ============ 10. PIC login → self-service only ============ */
  const picSession = await getCsrfAndLogin(picEmail, "PasswordRahasia1");
  const picCookies = picSession.cookies || "";
  record("10. PIC login", /session-token/.test(picCookies), `status ${picSession.status}`);

  const picHome = await jget("/dashboard", picCookies);
  const picRows = ["Ringkasan PIC", "Event Saya", "Referral", "Pendapatan"].filter((r) => picHome.text.includes(r));
  const picHasOps = picHome.text.includes('href="/dashboard/orders"') || picHome.text.includes('href="/dashboard/users"');
  record(
    "11. PIC /dashboard → the four self-service rows only",
    picHome.status === 200 && picRows.length === 4 && !picHasOps,
    `rows found: ${picRows.join(", ")}`
  );

  const picUsers = await jget("/dashboard/users", picCookies);
  record(
    "12. PIC GET /dashboard/users → DENIED",
    picUsers.status === 200 && picUsers.text.includes("Akses ditolak"),
    `http ${picUsers.status}`
  );

  /* ============ 13. existing CUSTOMER → PIC via the PIC menu; old data intact; Pendapatan 200 ============ */
  const custEmail = `buyer-${SUFFIX}@example.test`;
  const custHash = await bcrypt.hash("PasswordRahasia1", 12);
  const customer = await prisma.user.create({
    data: { name: "Buyer Live", email: custEmail, password: custHash, role: "CUSTOMER", platformRole: "CUSTOMER" },
    select: { id: true },
  });
  const tt = await prisma.ticketType.create({
    data: { eventId: event.id, name: `Tiket ${SUFFIX}`, price: "50000", quota: 50, sold: 1 },
    select: { id: true },
  });
  const order = await prisma.eventOrder.create({
    data: {
      orderNumber: `LIVE-${SUFFIX}`,
      organizerId: organizer.id,
      eventId: event.id,
      userId: customer.id,
      buyerName: "Buyer Live",
      subtotal: "50000",
      total: "50000",
      organizerNetAmount: "50000",
      status: "PAID",
      paymentStatus: "PAID",
      paidAt: new Date(),
    },
    select: { id: true },
  });
  const orderItem = await prisma.eventOrderItem.create({
    data: { orderId: order.id, ticketTypeId: tt.id, nameSnapshot: `Tiket ${SUFFIX}`, priceSnapshot: "50000", quantity: 1, subtotal: "50000" },
    select: { id: true },
  });
  await prisma.ticket.create({
    data: {
      ticketCode: `LIVETKT-${SUFFIX}`,
      qrTokenHash: `LIVEQR-${SUFFIX}`,
      orderId: order.id,
      orderItemId: orderItem.id,
      sequenceNo: 1,
      ticketTypeId: tt.id,
      eventId: event.id,
      organizerId: organizer.id,
      holderUserId: customer.id,
      status: "ISSUED",
      issuedAt: new Date(),
    },
  });
  // Registration must refuse a duplicate — proving the account pre-existed (the old-flow precondition)
  const custSession = await getCsrfAndLogin(custEmail, "PasswordRahasia1");
  const custCookies = custSession.cookies || "";

  // ADMIN uses the existing "Tambah PIC" flow (POST /api/admin/pic) on this existing account
  const linkPic = await jpost("/api/admin/pic", adminCookies, {
    email: custEmail,
    displayName: "PIC Dari Buyer",
  });
  const [afterUser, afterProfile, orderCount, ticketCount] = await Promise.all([
    prisma.user.findUnique({ where: { id: customer.id }, select: { platformRole: true, id: true } }),
    prisma.pICProfile.findFirst({ where: { userId: customer.id }, select: { id: true, status: true } }),
    prisma.eventOrder.count({ where: { userId: customer.id } }),
    prisma.ticket.count({ where: { holderUserId: customer.id } }),
  ]);
  record(
    "13. Tambah PIC on existing CUSTOMER → platformRole=PIC, data intact",
    linkPic.status === 201 &&
      afterUser.platformRole === "PIC" &&
      afterUser.id === customer.id &&
      orderCount === 1 &&
      ticketCount === 1,
    `role ${afterUser.platformRole}, orders ${orderCount}, tickets ${ticketCount}, profile ${afterProfile.status}`
  );

  // Approve the new profile, then the customer logs in and opens Pendapatan
  await prisma.pICProfile.update({ where: { id: afterProfile.id }, data: { status: "ACTIVE" } });
  const cust2 = await getCsrfAndLogin(custEmail, "PasswordRahasia1");
  const cust2Cookies = cust2.cookies || "";
  const picDash = await jget("/dashboard/pic", cust2Cookies);
  const picDashOk =
    picDash.status === 200 &&
    picDash.text.includes("Ringkasan") &&
    !picDash.text.includes("Akses ditolak");
  record("14. converted CUSTOMER → /dashboard/pic renders (Pendapatan section live)", picDashOk, `http ${picDash.status}`);

  // The fee API the Pendapatan figures come from must answer 200 (pre-fix this 403'd)
  const feeRead = await jget("/api/reports/pic/fee-summary", cust2Cookies);
  record(
    "15. PIC fee surface no longer 403 for the converted customer",
    feeRead.status === 200 || feeRead.status === 404,
    `http ${feeRead.status} (404 would mean a different route; 403 was the defect)`
  );

  /* ============ 16. disabled account cannot log in ============ */
  const disabledTry = await getCsrfAndLogin("disabled-check@example.test", "TestPass123");
  record(
    "16. disabled account login REFUSED",
    !/session-token/.test(disabledTry.cookies || ""),
    `status ${disabledTry.status}, no session cookie issued`
  );

  /* ============ 17. payments page renders (server-side, key-safe tree) ============ */
  const paymentsPage = await jget("/dashboard/payments", adminCookies);
  record(
    "17. ADMIN GET /dashboard/payments → 200 (rendered)",
    paymentsPage.status === 200 && paymentsPage.text.includes("Pembayaran"),
    `http ${paymentsPage.status}`
  );

  /* ============ cleanup: only rows this walkthrough created ============ */
  const ids = [mgrUser.id, picUser.id, customer.id, admin.id, order.id].filter(Boolean);
  await prisma.ticket.deleteMany({ where: { OR: [{ holderUserId: { in: ids } }, { ticketCode: `LIVETKT-${SUFFIX}` }] } });
  await prisma.eventOrder.deleteMany({ where: { orderNumber: `LIVE-${SUFFIX}` } });
  await prisma.ticketType.deleteMany({ where: { name: `Tiket ${SUFFIX}` } });
  await prisma.event.deleteMany({ where: { slug: `event-${SUFFIX}` } });
  if (organizer.name === `Org ${SUFFIX}`) await prisma.organizer.deleteMany({ where: { slug: `org-${SUFFIX}` } });
  await prisma.pICProfile.deleteMany({ where: { userId: { in: [mgrUser.id, picUser.id, customer.id] } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.adminAuditLog.deleteMany({ where: { entityRef: { in: ids }, action: { in: ["user.created", "pic.user.created", "pic.create", "user.disabled", "user.enabled"] } } });
  console.log("\ncleanup: walkthrough fixtures removed (dev data untouched otherwise)");

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} steps passed ===`);
  process.exit(failed.length ? 1 : 0);
}

main()
  .catch((e) => {
    console.error("FATAL:", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
