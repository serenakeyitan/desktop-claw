const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('socialAPI', {
  // Auth
  signUp: (email, password, username, twitter, github) =>
    ipcRenderer.invoke('social-sign-up', email, password, username, twitter, github),
  signIn: (email, password) =>
    ipcRenderer.invoke('social-sign-in', email, password),
  signOut: () => ipcRenderer.invoke('social-sign-out'),
  sendPasswordReset: (email) => ipcRenderer.invoke('social-send-reset', email),
  resetPassword: (email, otpCode, newPassword) =>
    ipcRenderer.invoke('social-reset-password', email, otpCode, newPassword),
  getProfile: () => ipcRenderer.invoke('social-get-profile'),
  updateProfile: (updates) => ipcRenderer.invoke('social-update-profile', updates),
  isLoggedIn: () => ipcRenderer.invoke('social-is-logged-in'),
  openExternal: (url) => ipcRenderer.invoke('open-external-url', url),

  // Friends
  addFriend: (code) => ipcRenderer.invoke('social-add-friend', code),
  getFriends: () => ipcRenderer.invoke('social-get-friends'),
  removeFriend: (friendId) => ipcRenderer.invoke('social-remove-friend', friendId),

  // Rankings
  getFriendRanking: (period) => ipcRenderer.invoke('social-friend-ranking', period),
  getGlobalRanking: (period) => ipcRenderer.invoke('social-global-ranking', period),

  // Local ranking (per-project)
  getLocalRanking: (period) => ipcRenderer.invoke('get-ranking', period),

  // Local info (detected tier + active sessions)
  getLocalInfo: () => ipcRenderer.invoke('social-get-local-info'),

  // Pokes
  sendPoke: (recipientId) => ipcRenderer.invoke('social-send-poke', recipientId),
  triggerSelfPoke: () => ipcRenderer.invoke('trigger-self-poke'),
});
