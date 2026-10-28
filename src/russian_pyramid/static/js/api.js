// Thin fetch wrappers for the JSON API.

async function req(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

export const api = {
  state: () => req('GET', '/api/state'),

  shoot: (params) => req('POST', '/api/shoot', params ? { params } : {}),
  predict: (params) => req('POST', '/api/predict', { params }),

  aim: (params) => req('POST', '/api/aim', params),
  undo: () => req('POST', '/api/undo', {}),

  moveBall: (id, xy) => req('POST', '/api/balls/move', { id, xy }),
  addBall: (xy) => req('POST', '/api/balls/add', { xy }),
  removeBall: (id) => req('POST', '/api/balls/remove', { id }),
  layout: (balls) => req('POST', '/api/layout', { balls }),

  setDrill: (name) => req('POST', '/api/drill', { name }),
  setPhysics: (preset) => req('POST', '/api/physics', { preset }),
  respawnCue: () => req('POST', '/api/respawn-cue', {}),
  setCueBall: (id) => req('POST', '/api/cue-ball', { id }),
};
