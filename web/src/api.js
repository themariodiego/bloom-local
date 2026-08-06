const BASE = '/api';

async function json(path, options = {}) {
  const res = await fetch(BASE + path, {
    headers: options.body instanceof FormData
      ? undefined
      : { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.error ?? `Request failed (${res.status})`);
    err.kind = data?.kind;
    throw err;
  }
  return data;
}

export const api = {
  models: () => json('/models'),
  health: () => json('/health'),

  courses: () => json('/courses'),
  course: (id) => json(`/courses/${id}`),
  deleteCourse: (id) => json(`/courses/${id}`, { method: 'DELETE' }),
  setModel: (id, model) =>
    json(`/courses/${id}/model`, { method: 'PUT', body: JSON.stringify({ model }) }),
  setSyllabus: (id, content) =>
    json(`/courses/${id}/syllabus`, { method: 'PUT', body: JSON.stringify({ content }) }),

  fromSource: (form) =>
    json('/courses/from-source', { method: 'POST', body: form }),
  fromProject: (form) =>
    json('/courses/from-project', { method: 'POST', body: form }),

  lesson: (courseId, num) => json(`/courses/${courseId}/lessons/${num}`),
  markOpened: (courseId, num) =>
    json(`/courses/${courseId}/lessons/${num}/opened`, { method: 'POST' }),
  saveFeedback: (courseId, num, body) =>
    json(`/courses/${courseId}/lessons/${num}/feedback`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteAnnotation: (courseId, num, aid) =>
    json(`/courses/${courseId}/lessons/${num}/annotations/${aid}`, {
      method: 'DELETE',
    }),

  stats: () => json('/stats'),
  calendar: () => json('/calendar'),
  recommendations: () => json('/recommendations'),
  generateRecommendations: (model) =>
    json('/recommendations/generate', {
      method: 'POST',
      body: JSON.stringify({ model }),
    }),
  setRecommendation: (id, status) =>
    json(`/recommendations/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ status }),
    }),
};

/**
 * POST to an SSE endpoint and invoke `onEvent` for each frame.
 * Returns an abort function.
 */
export function streamPost(path, body, onEvent) {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch(BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        let message = `Request failed (${res.status})`;
        try {
          message = (await res.json()).error ?? message;
        } catch { /* keep the default */ }
        onEvent({ type: 'error', message });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep).trim();
          buffer = buffer.slice(sep + 2);
          if (!frame.startsWith('data: ')) continue;
          try {
            onEvent(JSON.parse(frame.slice(6)));
          } catch { /* skip malformed frame */ }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        onEvent({ type: 'error', message: err.message || 'Connection lost.' });
      }
    }
  })();

  return () => controller.abort();
}
