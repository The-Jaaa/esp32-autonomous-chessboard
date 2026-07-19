async function request(path, options = {}) {
  const response = await fetch(`/api/mentor${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    },
    ...options
  });

  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}

export const mentorApi = {
  listConversations(query = '') {
    return request(`/conversations?query=${encodeURIComponent(query)}`);
  },
  createConversation() {
    return request('/conversations', { method: 'POST', body: '{}' });
  },
  getConversation(id) {
    return request(`/conversations/${id}`);
  },
  renameConversation(id, title) {
    return request(`/conversations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title })
    });
  },
  deleteConversation(id) {
    return request(`/conversations/${id}`, { method: 'DELETE' });
  },
  sendMessage(id, requestId, text) {
    return request(`/conversations/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ requestId, text })
    });
  }
};
