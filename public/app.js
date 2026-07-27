'use strict';

const UI_REFRESH_MS = 3000;

let state = null;
let reorgs = null;
/** Server-minus-browser clock offset, so slot maths follows the server. */
let clockOffset = 0;
let activeTab = 'fcr';

/* ---------- helpers ---------- */

const $ = (selector) => document.querySelector(selector);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const serverNow = () => Math.floor(Date.now() / 1000) + clockOffset;

function shortHash(hash) {
  return hash ? `${hash.slice(0, 10)}…${hash.slice(-8)}` : '—';
}

function formatAge(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 0) return '0s';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function formatUtc(unixSeconds) {
  if (!unixSeconds) return '—';
  return `${new Date(unixSeconds * 1000).toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

function copyOnClick(node, value) {
  node.title = `${value}\n(click to copy)`;
  node.addEventListener('click', () => {
    navigator.clipboard?.writeText(value).then(
      () => {
        const original = node.textContent;
        node.textContent = 'copied';
        setTimeout(() => {
          node.textContent = original;
        }, 900);
      },
      () => undefined,
    );
  });
}

/* ---------- FCR tab ---------- */

function metricRow(tag, view) {
  const row = el('div', 'metric');

  const label = el('div', `metric-tag ${tag}`);
  label.append(el('i'), document.createTextNode(tag));
  row.append(label);

  const value = el('div', 'metric-value');
  value.append(el('div', 'metric-number', view ? view.number.toLocaleString('en-US') : '—'));
  const hash = el('div', 'metric-hash', shortHash(view && view.hash));
  if (view) copyOnClick(hash, view.hash);
  value.append(hash);
  row.append(value);

  const side = el('div', 'metric-side');
  if (view) {
    side.append(el('b', null, `slot ${view.slot.toLocaleString('en-US')}`));
    side.append(document.createTextNode(`epoch ${view.epoch.toLocaleString('en-US')}`));
    side.append(el('b', null, formatAge(serverNow() - view.timestamp) + ' ago'));
  } else {
    side.append(el('b', null, 'unavailable'));
  }
  row.append(side);

  return row;
}

/**
 * Renders epoch rows of slot cells. Each cell is coloured by how far the three
 * tags have advanced past that slot, which is the whole point of the view:
 * orange is finalised, green is fast-confirmed, blue is proposed but not yet
 * confirmed.
 */
function slotGrid(client, chain, currentSlot, epochsShown) {
  const wrap = el('div', 'grid-wrap');
  const slotsPerEpoch = chain.slotsPerEpoch;
  const currentEpoch = Math.floor(currentSlot / slotsPerEpoch);

  const safeSlot = client.safe ? client.safe.slot : -1;
  const finalizedSlot = client.finalized ? client.finalized.slot : -1;
  const latestSlot = client.latest ? client.latest.slot : -1;

  for (let offset = 0; offset < epochsShown; offset += 1) {
    const epoch = currentEpoch - offset;
    if (epoch < 0) break;

    const row = el('div', 'epoch-row');
    row.append(el('div', 'epoch-label', String(epoch)));

    const slots = el('div', 'slots');
    for (let index = 0; index < slotsPerEpoch; index += 1) {
      const slot = epoch * slotsPerEpoch + index;
      const cell = el('a', 'slot');
      cell.href = `https://beaconcha.in/slot/${slot}`;
      cell.target = '_blank';
      cell.rel = 'noopener noreferrer';

      if (slot > currentSlot) {
        // leave as future
      } else if (slot <= finalizedSlot) {
        cell.classList.add('finalized');
      } else if (slot <= safeSlot) {
        cell.classList.add('safe');
      } else if (slot <= latestSlot) {
        cell.classList.add('proposed');
      } else {
        cell.classList.add('pending');
      }

      if (slot === currentSlot) cell.classList.add('current');
      cell.title = `slot ${slot} · epoch ${epoch}\n(click to open on beaconcha.in)`;
      slots.append(cell);
    }
    row.append(slots);
    wrap.append(row);
  }

  return wrap;
}

function clientCard(client, chain, currentSlot, epochsShown) {
  const card = el('div', 'client-card');

  const head = el('div', 'client-head');
  head.append(el('span', `status-dot ${client.online ? 'up' : 'down'}`));
  head.append(el('span', 'client-name', client.label));

  if (client.version) {
    const version = el('a', 'client-version', client.version);
    version.href = client.releaseUrl;
    version.target = '_blank';
    version.rel = 'noopener noreferrer';
    version.title = `${client.label} ${client.version} release notes`;
    head.append(version);
  }

  const meta = el('div', 'client-head-meta');
  meta.textContent = `${client.trackedSafeBlocks} safe blocks tracked · polled ${formatAge(
    client.updatedAt ? serverNow() - client.updatedAt : null,
  )} ago`;
  head.append(meta);
  card.append(head);

  if (client.error) {
    card.append(el('div', 'client-error', client.error));
  }

  const metrics = el('div', 'metrics');
  metrics.append(metricRow('safe', client.safe));
  metrics.append(metricRow('finalized', client.finalized));
  metrics.append(metricRow('latest', client.latest));
  card.append(metrics);

  card.append(slotGrid(client, chain, currentSlot, epochsShown));
  return card;
}

function renderFcr() {
  if (!state) return;

  const currentSlot = Math.floor((serverNow() - state.chain.genesisTime) / state.chain.slotSeconds);
  $('#current-slot').textContent = currentSlot.toLocaleString('en-US');
  $('#current-epoch').textContent = Math.floor(currentSlot / state.chain.slotsPerEpoch).toLocaleString('en-US');
  $('#poll-interval').textContent = String(state.pollIntervalMs / 1000);

  const banner = $('#divergence-banner');
  const diverged = state.divergence.filter((entry) => entry.diverged);
  if (diverged.length > 0) {
    banner.hidden = false;
    banner.textContent = `Clients disagree on the ${diverged
      .map((entry) => entry.tag)
      .join(' and ')} block hash at the same height. Check the Reorg tab.`;
  } else {
    banner.hidden = true;
  }

  const container = $('#clients');
  container.textContent = '';
  for (const client of state.clients) {
    container.append(clientCard(client, state.chain, currentSlot, state.epochsShown));
  }

  // Planned clients sit in their own compact row rather than the main grid --
  // as full-size cards they would be mostly empty space.
  const planned = $('#planned');
  planned.textContent = '';
  for (const entry of state.plannedClients ?? []) {
    const card = el('div', 'planned-card');
    const heading = el('div', 'planned-head');
    heading.append(el('span', 'status-dot'));
    heading.append(el('span', 'planned-name', entry.label));
    card.append(heading);
    card.append(el('div', 'planned-note', entry.note));
    planned.append(card);
  }
}

/* ---------- Reorg tab ---------- */

const TYPE_LABEL = {
  finalized_mismatch: 'finalized mismatch',
  safe_reorg: 'safe reorg',
  safe_regression: 'safe regression',
};

function reorgCard(event) {
  const card = el('div', 'reorg-card');

  const head = el('div', 'reorg-head');
  head.append(el('span', 'reorg-type', TYPE_LABEL[event.type] || event.type));
  head.append(el('span', 'reorg-client', event.client));
  head.append(el('span', 'reorg-when', formatUtc(event.detectedAt)));
  card.append(head);

  card.append(el('div', 'reorg-note', event.note));

  const list = el('dl', 'reorg-hashes');
  const add = (term, definition, className) => {
    list.append(el('dt', null, term));
    list.append(el('dd', className, definition));
  };
  add('block number', event.blockNumber.toLocaleString('en-US'));
  if (event.slot !== null) add('slot / epoch', `${event.slot} / ${event.epoch}`);
  add('recorded safe hash', event.recordedSafeHash, 'hash-old');
  add(
    event.type === 'finalized_mismatch' ? 'finalized hash' : 'observed hash',
    event.observedHash,
    'hash-new',
  );
  if (event.recordedAt) add('safe seen at', formatUtc(event.recordedAt));
  add('detected at', formatUtc(event.detectedAt));
  card.append(list);

  return card;
}

function renderReorgs() {
  if (!reorgs) return;

  const badge = $('#reorg-badge');
  badge.hidden = reorgs.reorgs.length === 0;
  badge.textContent = String(reorgs.reorgs.length);

  const container = $('#reorg-content');
  container.textContent = '';

  if (reorgs.reorgs.length === 0) {
    const empty = el('div', 'empty-state');
    empty.append(el('div', 'empty-icon', '✓'));
    empty.append(el('div', 'empty-title', `No reorg since ${formatUtc(reorgs.startedAt)}`));
    empty.append(
      el(
        'div',
        'empty-sub',
        `monitoring for ${formatAge(reorgs.startedAt ? reorgs.now - reorgs.startedAt : null)}`,
      ),
    );
    container.append(empty);
    return;
  }

  const list = el('div', 'reorg-list');
  for (const event of reorgs.reorgs) list.append(reorgCard(event));
  container.append(list);
}

/* ---------- polling ---------- */

async function refresh() {
  try {
    const [stateResponse, reorgResponse] = await Promise.all([fetch('/api/state'), fetch('/api/reorgs')]);
    if (!stateResponse.ok) throw new Error(`/api/state returned ${stateResponse.status}`);
    if (!reorgResponse.ok) throw new Error(`/api/reorgs returned ${reorgResponse.status}`);

    state = await stateResponse.json();
    reorgs = await reorgResponse.json();
    clockOffset = state.now - Math.floor(Date.now() / 1000);

    $('#last-update').textContent = new Date().toISOString().slice(11, 19);
    $('#footer-status').textContent = 'connected';

    renderFcr();
    renderReorgs();
  } catch (error) {
    $('#footer-status').textContent = `disconnected: ${error.message}`;
  }
}

function setupTabs() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      activeTab = tab.dataset.tab;
      for (const other of document.querySelectorAll('.tab')) {
        const on = other === tab;
        other.classList.toggle('active', on);
        other.setAttribute('aria-selected', String(on));
      }
      for (const panel of document.querySelectorAll('.panel')) {
        panel.classList.toggle('active', panel.id === `panel-${activeTab}`);
      }
    });
  }
}

setupTabs();
refresh();
setInterval(refresh, UI_REFRESH_MS);
