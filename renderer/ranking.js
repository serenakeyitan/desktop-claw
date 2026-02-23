// Ranking window renderer script
let currentPeriod = 'today';

document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  loadRanking();
});

function setupTabs() {
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentPeriod = tab.dataset.period;
      loadRanking();
    });
  });
}

async function loadRanking() {
  try {
    const data = await window.rankingAPI.getRanking(currentPeriod);
    renderRanking(data.ranking, data.total);
  } catch (err) {
    console.error('Failed to load ranking:', err);
  }
}

function renderRanking(ranking, total) {
  const tableBody = document.getElementById('table-body');
  const emptyState = document.getElementById('empty-state');
  const totalValue = document.getElementById('total-value');

  // Update total
  totalValue.textContent = `${total.totalDelta.toFixed(1)}%`;

  if (!ranking || ranking.length === 0) {
    tableBody.innerHTML = '';
    tableBody.appendChild(createEmptyState());
    return;
  }

  // Hide empty state and build rows
  const maxDelta = ranking[0]?.totalDelta || 1;

  const fragment = document.createDocumentFragment();

  for (const item of ranking) {
    const row = document.createElement('div');
    row.className = `ranking-row${item.rank <= 3 ? ` rank-${item.rank}` : ''}`;

    const barWidth = maxDelta > 0 ? (item.totalDelta / maxDelta) * 100 : 0;

    row.innerHTML = `
      <span class="col-rank">${item.rank}</span>
      <div class="project-cell col-project">
        <span class="project-name">${escapeHtml(item.project)}</span>
        <div class="usage-bar"><div class="usage-bar-fill" style="width: ${barWidth}%"></div></div>
      </div>
      <span class="col-usage"><span class="usage-value">${item.totalDelta.toFixed(1)}%</span></span>
      <span class="col-time">${formatTime(item.totalTimeMs)}</span>
      <span class="col-sessions">${item.sessionCount}</span>
    `;

    fragment.appendChild(row);
  }

  tableBody.innerHTML = '';
  tableBody.appendChild(fragment);
}

function createEmptyState() {
  const el = document.createElement('div');
  el.id = 'empty-state';
  el.textContent = 'No usage data yet. Start using Claude Code!';
  return el;
}

function formatTime(ms) {
  if (!ms || ms <= 0) return '0m';
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return '<1m';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Auto-refresh every 30 seconds while window is open
setInterval(() => {
  loadRanking();
}, 30000);
