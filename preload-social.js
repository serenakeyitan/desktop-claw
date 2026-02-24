const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('socialAPI', {
  // Auth
  signUp: (email, password, username) =>
    ipcRenderer.invoke('social-sign-up', email, password, username),
  signIn: (email, password) =>
    ipcRenderer.invoke('social-sign-in', email, password),
  signOut: () => ipcRenderer.invoke('social-sign-out'),
  getProfile: () => ipcRenderer.invoke('social-get-profile'),
  isLoggedIn: () => ipcRenderer.invoke('social-is-logged-in'),

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
});
