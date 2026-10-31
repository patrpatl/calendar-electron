const { contextBridge, ipcRenderer } = require('electron');

// Expose only the three calendar operations, never unrestricted IPC or files.
contextBridge.exposeInMainWorld('calendarAPI', {
    list: () => ipcRenderer.invoke('calendar:list'),
    save: event => ipcRenderer.invoke('calendar:save', event),
    delete: id => ipcRenderer.invoke('calendar:delete', id),
    onWindowClose: callback => {
        const listener = async (_event, requestId) => {
            let ok = false;
            try { ok = await callback(); } catch {}
            ipcRenderer.send('calendar:close-ready', { requestId, ok: ok === true });
        };
        ipcRenderer.on('calendar:flush-editor', listener);
        ipcRenderer.send('calendar:editor-ready');
        return () => ipcRenderer.removeListener('calendar:flush-editor', listener);
    }
});

contextBridge.exposeInMainWorld('settingsAPI', {
    get: () => ipcRenderer.invoke('settings:get'),
    setTheme: theme => ipcRenderer.invoke('settings:set-theme', theme),
    onChanged: callback => {
        const listener = (_event, settings) => callback(settings);
        ipcRenderer.on('settings:changed', listener);
        return () => ipcRenderer.removeListener('settings:changed', listener);
    }
});

contextBridge.exposeInMainWorld('driveAPI', {
    status: () => ipcRenderer.invoke('drive:status'),
    importClient: () => ipcRenderer.invoke('drive:import-client'),
    connect: () => ipcRenderer.invoke('drive:connect'),
    cancelConnect: () => ipcRenderer.invoke('drive:cancel-connect'),
    upload: () => ipcRenderer.invoke('drive:upload'),
    restore: () => ipcRenderer.invoke('drive:restore'),
    disconnect: () => ipcRenderer.invoke('drive:disconnect')
});
