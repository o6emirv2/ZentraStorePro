import { escapeHtml } from './admin-core.js?v=116';

export function renderSecurityAssessment(security, { scoreHost, chip, levelHost, ring, checksHost, metricsHost, formatDate }) {
  const score = Math.max(0, Math.min(100, Number(security.score) || 0));
  const measured = Number.isFinite(security.score) && Array.isArray(security.checks) && security.checks.length > 0;
  scoreHost.textContent = measured ? String(score) : '—'; chip.textContent = measured ? `${score}/100` : 'Doğrulanmadı';
  levelHost.textContent = String(security.level || 'Doğrulanmadı').toLocaleUpperCase('tr-TR');
  const color = !measured ? '#94a3b8' : security.criticalCount > 0 ? '#ff7485' : security.pendingCount > 0 ? '#e7b765' : 'var(--green)';
  ring.style.background = `radial-gradient(closest-side, #0b1322 80%, transparent 81%), conic-gradient(${color} ${score}%, #25324a 0)`;
  levelHost.style.color = color; chip.style.color = color;
  ring.closest('.security-overview')?.style.setProperty('--assessment-color', color);
  const fields = [['Dört kritik kontrol',security.criticalMax ? String(security.criticalScore)+'/20':'Doğrulanmadı'],['Son denetim' , formatDate(security.checkedAt)], ['Kontrol', security.controlCount], ['Başarılı', security.passedCount],
    ['Başarısız', security.failedCount], ['Doğrulanmamış', security.unverifiedCount], ['Başarısız kritik kontrol', security.criticalCount], ['Çözüm bekleyen', security.pendingCount]];
  metricsHost.innerHTML = `<dl class="security-metrics">${fields.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value ?? '—')}</dd></div>`).join('')}</dl><p>${escapeHtml(security.scope || 'Doğrulanmış güvenlik değerlendirmesi henüz alınmadı.')}</p>`;
  const labels = { passed: 'Başarılı', failed: 'Başarısız', unverified: 'Doğrulanmamış', partial: 'Kısmen doğrulandı', running: 'Denetim devam ediyor' };
  checksHost.innerHTML = (security.checks || []).map(check => `<article class="security-check ${check.ok ? 'is-ready' : ''}" data-status="${escapeHtml(check.status)}"><i class="fa-solid ${check.ok ? 'fa-circle-check' : check.status === 'unverified' ? 'fa-circle-question' : 'fa-triangle-exclamation'}" aria-hidden="true"></i><span><strong>${escapeHtml(check.label)}</strong><small>${escapeHtml(labels[check.status] || 'Doğrulanmamış')}${check.critical && !check.ok ? ' · KRİTİK KONTROL' : ''}</small><p>${escapeHtml(check.detail)}</p><p>Son doğrulama · ${escapeHtml(check.checkedAt?formatDate(check.checkedAt):'Üretim kaydı yok')}</p>${check.evidence?'<details><summary>Doğrulama kanıtları</summary><p>'+escapeHtml(check.evidence.reference)+'</p><ul>'+check.evidence.checks.map(x=>'<li>'+escapeHtml(x.id)+' · '+escapeHtml(labels[x.status]||x.status)+(x.artifactHash?' · '+escapeHtml(x.artifactHash):'')+'</li>').join('')+'</ul></details>':''}${check.remediation ? `<p><strong>Gerekli işlem:</strong> ${escapeHtml(check.remediation)}</p>` : ''}</span><b>${escapeHtml(check.earned)}/${escapeHtml(check.weight)}</b></article>`).join('');
}
