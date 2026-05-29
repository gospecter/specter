/**
 * Preload — exposes a typed IPC API to all renderer windows via contextBridge.
 *
 * window.api mirrors the methods a renderer needs; it maps to ipcMain.handle
 * channels registered in ipc.ts.
 *
 * Keep this file lean — no business logic, only bridge calls.
 */
import { contextBridge, ipcRenderer } from 'electron';
const api = {
    config: {
        read: () => ipcRenderer.invoke('config:read'),
        write: (cfg) => ipcRenderer.invoke('config:write', cfg),
        exists: () => ipcRenderer.invoke('config:exists'),
    },
    ghost: {
        test: (url, key) => ipcRenderer.invoke('ghost:test', url, key),
    },
    daemon: {
        status: () => ipcRenderer.invoke('daemon:status'),
        start: () => ipcRenderer.invoke('daemon:start'),
        stop: () => ipcRenderer.invoke('daemon:stop'),
        restart: () => ipcRenderer.invoke('daemon:restart'),
        runSync: (cmd = 'sync') => ipcRenderer.invoke('daemon:run-sync', cmd),
    },
    license: {
        status: () => ipcRenderer.invoke('license:status'),
        activate: (key) => ipcRenderer.invoke('license:activate', key),
        deactivate: () => ipcRenderer.invoke('license:deactivate'),
    },
    dialog: {
        pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
    },
    preview: {
        fetch: () => ipcRenderer.invoke('preview:fetch'),
    },
};
contextBridge.exposeInMainWorld('api', api);
//# sourceMappingURL=preload.js.map