let expanded = false;
let recording = false;
let media = null;
let chunks = [];
let drag = null;

const bubble = document.getElementById('bubble');
const panel = document.getElementById('panel');
const pendingEl = document.getElementById('pending');
const status = document.getElementById('status');

function setExpanded(next) {
  if (next === expanded) return;
  expanded = next;
  bubble.classList.toggle('hidden', expanded);
  panel.classList.toggle('hidden', !expanded);
  window.simba.overlaySize(expanded);
  if (expanded) refresh();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

bubble.addEventListener('pointerdown', (e) => {
  drag = { x: e.screenX, y: e.screenY, moved: false };
});
window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.screenX - drag.x;
  const dy = e.screenY - drag.y;
  if (Math.abs(dx) > 4 || Math.abs(dy) > 4) drag.moved = true;
  if (drag.moved) {
    window.simba.moveOverlay(dx, dy);
    drag.x = e.screenX;
    drag.y = e.screenY;
  }
});
window.addEventListener('pointerup', () => {
  if (drag && !drag.moved && !expanded) setExpanded(true);
  drag = null;
});

document.getElementById('close').onclick = () => setExpanded(false);
document.getElementById('talk').onclick = () => window.simba.openMain();

window.simba.onOverlayToggle(() => setExpanded(!expanded));
window.simba.onPtt(() => startTalk());

async function refresh() {
  try {
    const pending = await window.simba.pending();
    const n = pending?.length || 0;
    bubble.textContent = String(n);
    bubble.className = `bubble ${n ? 'hot' : 'ok'}`;
    pendingEl.innerHTML = n
      ? pending
          .map(
            (a) => `<article class="card" data-id="${a.id}">
              <div>${esc(a.summary || a.action_class || a.id)}</div>
              <div class="row" style="margin-top:6px">
                <button data-ok="1">Approve</button>
                <button class="ghost" data-ok="0">Deny</button>
              </div>
            </article>`,
          )
          .join('')
      : '<p>Nothing waiting.</p>';
    pendingEl.querySelectorAll('button').forEach((b) => {
      b.onclick = async () => {
        await window.simba.confirm(b.closest('[data-id]').dataset.id, b.dataset.ok === '1');
        await refresh();
      };
    });
  } catch {
    bubble.textContent = '·';
    bubble.className = 'bubble off';
    pendingEl.innerHTML = '<p>Gateway offline.</p>';
  }
}

document.getElementById('save').onclick = async () => {
  const note = document.getElementById('note');
  const text = note.value.trim();
  if (!text) return;
  status.textContent = 'Saving…';
  try {
    await window.simba.capture(text);
    note.value = '';
    status.textContent = 'Captured.';
  } catch (e) {
    status.textContent = e.message;
  }
};

document.getElementById('send').onclick = async () => {
  const box = document.getElementById('say');
  const text = box.value.trim();
  if (!text) return;
  status.textContent = 'Sending…';
  try {
    await window.simba.say(text);
    box.value = '';
    status.textContent = 'Sent to Simba.';
  } catch (e) {
    status.textContent = e.message;
  }
};

async function playSpeech(text) {
  try {
    const bytes = await window.simba.voiceSpeak(text);
    const u8 = new Uint8Array(bytes);
    const url = URL.createObjectURL(new Blob([u8], { type: 'audio/wav' }));
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    await audio.play();
  } catch {
    // Speaking is best-effort; the words are already on screen.
  }
}

async function startTalk() {
  if (recording) return stopTalk();
  setExpanded(true);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    media = new MediaRecorder(stream);
    media.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    media.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: media.mimeType || 'audio/webm' });
      const buf = await blob.arrayBuffer();
      status.textContent = 'Hearing…';
      try {
        const r = await window.simba.voiceAsk(Array.from(new Uint8Array(buf)), 'webm');
        if (r.reply) {
          status.textContent = r.reply;
          await playSpeech(r.reply);
        } else if (r.heard) {
          status.textContent = `Heard: ${r.heard}`;
        } else {
          status.textContent = 'Sent.';
        }
      } catch (e) {
        status.textContent = e.message;
      }
    };
    media.start();
    recording = true;
    status.textContent = 'Listening… tap Hold to talk again to stop.';
  } catch (e) {
    status.textContent = e.message;
  }
}

async function stopTalk() {
  if (!media || !recording) return;
  recording = false;
  media.stop();
}

document.getElementById('ptt').onclick = () => startTalk();

refresh();
setInterval(refresh, 20000);
