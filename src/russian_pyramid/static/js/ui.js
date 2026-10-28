// DOM helpers: toasts, stats, attempts list, banner, controls.

import { v0ToPercent, formatShotPower } from './aim.js';

export function $(id) { return document.getElementById(id); }

export function toast(msg, kind = 'info', ms = 2600) {
  const el = document.createElement('div');
  el.className = `toast${kind === 'error' ? ' error' : ''}`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export function updateStats(state) {
  const { stats } = state;
  $('stats').innerHTML = `
    <div class="stat"><b>${stats.shots}</b><span>shots</span></div>
    <div class="stat"><b>${stats.pots}</b><span>pots</span></div>
    <div class="stat"><b>${stats.scratches}</b><span>scratches</span></div>`;
}

export function renderAttempts(state, onReplay, activeN = null) {
  const ul = $('attempts');
  ul.innerHTML = '';
  if (!state.attempts.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No shots yet.';
    ul.appendChild(li);
    return;
  }
  for (const a of [...state.attempts].reverse()) {
    const li = document.createElement('li');
    if (activeN === a.n) li.className = 'active';
    const cls = a.cue_potted ? 'scratch' : (a.potted.length ? 'pot' : 'miss');
    li.innerHTML = `
      <span class="n">#${a.n}</span>
      <span class="dot ${cls}"></span>
      <span>${a.cue_potted ? 'scratch' : (a.potted.length ? `potted ${a.potted.map((id) => (id === 'cue' ? 'svoyak' : id)).join(', ')}` : 'missed')}</span>
      <span class="meta">${v0ToPercent(a.params.V0)}%</span>`;
    li.title = `φ ${a.params.phi.toFixed(2)}° · ${formatShotPower(a.params.V0)} · ` +
               `spin (${a.params.a.toFixed(2)}, ${a.params.b.toFixed(2)}) · ${a.duration.toFixed(1)} s`;
    li.addEventListener('click', () => onReplay(a.n));
    ul.appendChild(li);
  }
}

export function showBanner(kind, title, subtitle, buttons) {
  const el = $('banner');
  el.className = kind;
  el.innerHTML = '';
  const msg = document.createElement('div');
  msg.className = 'msg';
  msg.innerHTML = `${title}${subtitle ? `<small>${subtitle}</small>` : ''}`;
  el.appendChild(msg);
  for (const b of buttons || []) {
    const btn = document.createElement('button');
    btn.className = `btn${b.accent ? ' accent' : ''}`;
    btn.textContent = b.label;
    btn.addEventListener('click', b.onClick);
    el.appendChild(btn);
  }
  el.classList.remove('hidden');
}

export function hideBanner() {
  $('banner').classList.add('hidden');
}

export function setHint(text) {
  $('hint').textContent = text;
}
