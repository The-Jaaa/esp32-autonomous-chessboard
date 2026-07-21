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
  if (!response.ok) {
    const error = new Error(body.error || `Request failed (${response.status}).`);
    error.status = response.status;
    error.code = body.code;
    error.state = body.state;
    throw error;
  }
  return body;
}

export const mentorApi = {
  getAudioDevices() {
    return request('/audio/devices');
  },
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
  },
  move(id, uci, expectedRevision, actionId) {
    return request(`/conversations/${id}/moves`, {
      method: 'POST',
      body: JSON.stringify({ uci, expectedRevision, actionId })
    });
  },
  loadPosition(id, fen, expectedRevision, actionId) {
    return request(`/conversations/${id}/position`, {
      method: 'PUT',
      body: JSON.stringify({ fen, expectedRevision, actionId })
    });
  },
  resetBoard(id, expectedRevision, actionId) {
    return request(`/conversations/${id}/reset`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision, actionId })
    });
  },
  setOrientation(id, orientation, expectedRevision, actionId) {
    return request(`/conversations/${id}/board`, {
      method: 'PATCH',
      body: JSON.stringify({ orientation, expectedRevision, actionId })
    });
  },
  getCatalog(type = '') {
    return request(`/catalog${type ? `?type=${encodeURIComponent(type)}` : ''}`);
  },
  getProfile() {
    return request('/profile');
  },
  updateProfile(skillBand, goals) {
    return request('/profile', {
      method: 'PATCH',
      body: JSON.stringify({ skillBand, goals })
    });
  },
  startActivity(id, options) {
    return request(`/conversations/${id}/activities`, {
      method: 'POST',
      body: JSON.stringify(options)
    });
  },
  pauseActivity(id, activityId) {
    return request(`/conversations/${id}/activities/${activityId}/pause`, { method: 'POST', body: '{}' });
  },
  resumeActivity(id, activityId) {
    return request(`/conversations/${id}/activities/${activityId}/resume`, { method: 'POST', body: '{}' });
  },
  requestHint(id, activityId) {
    return request(`/conversations/${id}/activities/${activityId}/hint`, { method: 'POST', body: '{}' });
  },
  endActivity(id, activityId) {
    return request(`/conversations/${id}/activities/${activityId}/end`, { method: 'POST', body: '{}' });
  }
};
