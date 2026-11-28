import { escapeHtml as h } from "./admin-core.js?v=116";
import { openAdminDialog } from "./admin-dialogs.js?v=116";
import { advancedViews } from "./layout.mjs?v=117";
const choices = {
  users: [
    ["users", "Hesapları yönet"],
    ["commerce-support", "Destek ve yorumlar"],
    ["commerce-privacy", "Veri talepleri"],
  ],
  database: [["commerce-operations", "İndeksler ve sistem ayarları"]],
  security: [["security", "Güvenlik denetimi"]],
  backups: [["commerce-backups", "Yedek ve geri yükleme"]],
  email: [["content", "Bildirim gönderimi"]],
  integrations: [["supplier", "Tedarikçi bağlantısı"]],
  finance: [
    ["wallet", "Bakiye merkezi"],
    ["commerce-reports", "Satış ve maliyet"],
  ],
  system: [
    ["commerce-bulk", "Toplu ürün işlemleri"],
    ["experience", "Kategoriler ve vitrin"],
    ["commerce-catalog", "İçerik stüdyosu"],
    ["commerce-operations", "Sistem operasyonları"],
  ],
  blocks: [
    ["blocks", "Engel kayıtları"],
    ["removals", "Hesap silme işleri"],
  ],
};
const states = {
  passed: "Başarılı",
  failed: "Başarısız",
  partial: "Kısmen doğrulandı",
  unverified: "Henüz doğrulanmadı",
  pending: "Devam ediyor",
  completed: "Tamamlandı",
  needs_review: "İnceleme gerekiyor",
};
const date = (n) =>
  n
    ? new Date(n).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" })
    : "Henüz çalıştırılmadı";
export function createOperationsCenter({
  api,
  reauth,
  can,
  policy,
  go,
  logout,
  notify,
}) {
  let root,
    epoch = 0,
    mod,
    records = [],
    active = "";
  function summary(last) {
    return last
      ? "<strong>" +
          h(states[last.state] || last.state) +
          "</strong> · " +
          h(date(last.at)) +
          "<ul>" +
          last.details.map((d) => "<li>" + h(d) + "</li>").join("") +
          "</ul><small>İşlem " +
          h(last.reference) +
          "</small>"
      : "Henüz çalıştırılmadı";
  }
  function draw() {
    const menu = root.querySelector("#advancedToolsMenu");
    menu.innerHTML = records
      .map(
        (r) =>
          '<article class="tool-group"><h3>' +
          h(r.title) +
          "</h3><p>" +
          h(r.description) +
          "</p><small>Gerekli yetki · " +
          h(r.permission) +
          '</small><div class="tool-status" role="status">' +
          summary(r.last) +
          '</div><div class="tool-choices"><button class="primary-action" type="button" data-inspect="' +
          h(r.id) +
          '">Kontrolü çalıştır</button>' +
          (choices[r.id] || [])
            .filter(([id]) => {
              const row = advancedViews.find((x) => x[0] === id);
              return row
                ? can(row[3])
                : id === "removals"
                  ? can("store.users.delete")
                  : true;
            })
            .map(
              ([id, n]) =>
                '<button type="button" class="secondary-action" data-tool-view="' +
                id +
                '" aria-pressed="' +
                (active === id) +
                '">' +
                h(n) +
                "</button>",
            )
            .join("") +
          "</div></article>",
      )
      .join("");
  }
  async function management(kind, cursor = "") {
    const e = ++epoch,
      host = root.querySelector("[data-tool-result]"),
      out = (
        await api(
          "/api/admin/store/members/" +
            kind +
            "/list?cursor=" +
            encodeURIComponent(cursor),
        )
      ).result;
    if (e !== epoch) return;
    if (!cursor) {
      host.innerHTML =
        "<h2>" +
        (kind === "blocks" ? "Kayıt engelleri" : "Hesap silme işleri") +
        '</h2><div class="member-results"></div>';
    }
    host.querySelector("[data-tool-more]")?.remove();
    host
      .querySelector(".member-results")
      .insertAdjacentHTML(
        "beforeend",
        out.items
          .map(
            (r) =>
              '<article class="member-record"><h4>' +
              h(r.reference || r.id) +
              "</h4><p>" +
              h(kind === "blocks" ? r.reason : states[r.state] || r.state) +
              "</p><p>" +
              h(date(r.createdAt || r.updatedAt)) +
              "</p>" +
              (kind === "blocks"
                ? '<button class="danger-action" data-release="' +
                  h(r.id) +
                  '">Kayda yeniden izin ver</button>'
                : r.state === "needs_review"
                  ? '<button class="secondary-action" data-resume="' +
                    h(r.uid) +
                    '">İşlemi sürdür</button>'
                  : "") +
              "</article>",
          )
          .join("") || "<p>Kayıt bulunamadı.</p>",
      );
    if (out.nextCursor)
      host.insertAdjacentHTML(
        "beforeend",
        '<button class="secondary-action" data-tool-more="' +
          h(out.nextCursor) +
          '">Sonraki kayıtlar</button>',
      );
  }
  async function click(e) {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    const { inspect, toolView, release, resume, toolMore } = b.dataset;
    if (!(inspect || toolView || release || resume || toolMore)) return;
    b.disabled = true;
    try {
      if (inspect) {
        const r = records.find((x) => x.id === inspect);
        if (
          !(await openAdminDialog({
            title: r.title,
            description: r.description,
            confirmLabel: "Kontrolü Çalıştır",
          })) ||
          !(await reauth())
        )
          return;
        b.textContent = "Denetim sürüyor…";
        r.last = (
          await api("/api/admin/store/tools/" + inspect + "/run", {
            method: "POST",
            body: {},
          })
        ).result;
        draw();
        return;
      }
      if (release || resume) {
        const proof = await openAdminDialog({
          title: release ? "Yeniden kayda izin ver" : "Silme işlemine devam et",
          description: release
            ? "Kayıt engeli kaldırılacak."
            : "İşlem son doğrulanmış adımından sürdürülecek.",
          content: release
            ? '<label class="operation-field">TOTP kodu<input name="code" inputmode="numeric" pattern="[0-9]{6}" required></label>'
            : "",
          confirmLabel: "Parolayla Doğrula",
          destructive: true,
          collect: (f) => (release ? f.elements.code.value : true),
        });
        if (!proof || !(await reauth())) return;
        const path = release
          ? "blocks/" + encodeURIComponent(release) + "/release"
          : encodeURIComponent(resume) + "/removal/resume";
        await api("/api/admin/store/members/" + path, {
          method: "POST",
          body: release ? { totp: proof } : {},
        });
        return management(active);
      }
      if (toolMore) return management(active, toolMore);
      active = toolView;
      ++epoch;
      draw();
      if (["blocks", "removals"].includes(active)) await management(active);
      else if (advancedViews.some((x) => x[0] === active)) {
        mod ??= await import("./workspace.js?v=117");
        await mod.mountAdvanced(
          {
            root,
            context: policy(),
            api: async (path, opts = {}) => {
              const method = String(
                opts.method || (opts.body ? "POST" : "GET"),
              ).toUpperCase();
              if (
                !["GET", "HEAD"].includes(method) &&
                !opts.body?.password &&
                !opts.password &&
                !(await reauth())
              )
                throw Error("İşlem iptal edildi.");
              return api(path, opts);
            },
            onLogout: logout,
          },
          active,
        );
      } else {
        go(active);
        return;
      }
      root
        .querySelector("[data-tool-result]")
        .scrollIntoView({ block: "start" });
    } catch (err) {
      notify("error", "Araç işlemi tamamlanamadı", err.message);
    } finally {
      b.disabled = false;
    }
  }
  return {
    leave() {
      ++epoch;
      mod?.unmountWorkspace();
      active = "";
      root?.querySelector("[data-tool-result]")?.replaceChildren();
    },
    async load(host) {
      if (!root) {
        root = host;
        root.addEventListener("click", click);
      }
      const ticket = ++epoch;
      const out = await api("/api/admin/store/tools");
      if (epoch !== ticket) return;
      records = out.result;
      draw();
    },
  };
}
