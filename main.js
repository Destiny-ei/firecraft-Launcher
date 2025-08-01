const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { Client, Authenticator } = require('minecraft-launcher-core');
const { fabric } = require('tomate-loaders');
const fs = require('fs');
const { DownloaderHelper } = require('node-downloader-helper');
const { autoUpdater } = require('electron-updater');
const extract = require('extract-zip');
const util =require('util');
const { exec } = require('child_process');
const axios = require('axios');
const Rpc = require('discord-rpc');

const execPromise = util.promisify(exec);

// ==========================================================
//      INICIO: CONFIGURACIÓN DE DISCORD RICH PRESENCE
// ==========================================================

const clientId = '1400661686792491171'; 
Rpc.register(clientId);
const rpc = new Rpc.Client({ transport: 'ipc' });
let startTimestamp;
let serverStatus = null;

ipcMain.on('update-server-status', (event, status) => {
    serverStatus = status;
    if (isGameRunning) {
        const playerState = serverStatus && serverStatus.online 
            ? `(${serverStatus.players.online}/${serverStatus.players.max} jugadores)` 
            : 'Explorando mundos 🌎';
        setActivity(`Jugando FireMods`, playerState, 'firecraft_logo', 'minecraft_icon');
    }
});

async function setActivity(details, state, largeImageKey = 'firecraft_logo', smallImageKey = 'minecraft_icon') {
    if (!rpc || !mainWindow) return;

    const activityPayload = {
        details: details,
        state: state,
        startTimestamp,
        largeImageKey: largeImageKey,
        largeImageText: 'FireCraft Launcher',
        instance: false,
        buttons: [{
            label: 'Descargar Launcher',
            url: 'https://firemods.net/storage/Modpacks/launcher.zip'
        }]
    };

    if (smallImageKey) {
        activityPayload.smallImageKey = smallImageKey;
        activityPayload.smallImageText = 'Jugando Minecraft';
    }

    try {
        await rpc.setActivity(activityPayload);
    } catch (error) {
        console.error('[Discord RPC] Error al actualizar el estado:', error);
    }
}

function connectToDiscord() {
    rpc.login({ clientId }).catch(err => {
        console.error('[Discord RPC] No se pudo conectar a Discord. Reintentando en 15 segundos...');
        setTimeout(connectToDiscord, 15000);
    });
}

rpc.on('ready', () => {
    console.log('[Discord RPC] Conectado a Discord y listo.');
    startTimestamp = new Date();
    setActivity('En el launcher', 'Eligiendo una modalidad...');
});

app.on('before-quit', () => {
    if (rpc) rpc.destroy();
});

// ==========================================================
//      FIN: CONFIGURACIÓN DE DISCORD RICH PRESENCE
// ==========================================================


const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
}

let mainWindow;
const userDataPath = app.getPath('userData');
const minecraftPath = path.join(userDataPath, '.minecraft');

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 700,
        frame: false,
        resizable: false,
        transparent: true,
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            devTools: false,
        }
    });
    mainWindow.loadFile('index.html');
    mainWindow.on('closed', () => { mainWindow = null; });
    autoUpdater.checkForUpdatesAndNotify();
}

app.whenReady().then(() => {
    createWindow();
    connectToDiscord();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });


// ==========================================================
//      INICIO: GESTIÓN DE EVENTOS DE LA INTERFAZ
// ==========================================================

// --- ¡¡¡CÓDIGO AÑADIDO!!! ---
// Este es el listener que faltaba para minimizar la ventana.
ipcMain.on('minimize-window', () => {
    if (mainWindow) {
        mainWindow.minimize();
    }
});
// -----------------------------

let isGameRunning = false;

ipcMain.on('launch-minecraft', async (event, options) => {
    if (isGameRunning) return;
    
    isGameRunning = true;
    mainWindow.webContents.send('update-launch-button', isGameRunning);

    try {
        await checkForModpackUpdate(options.modality, event);
        
        setActivity('Lanzando el juego...', `Modalidad: ${options.modality}`);

        const auth = await Authenticator.getAuth(options.username || "microsoft");
        const modalityConfig = await getLaunchConfigForModality(options.modality, minecraftPath, event);
                
        const finalOptions = {
            root: minecraftPath,
            authorization: auth,
            memory: options.memory,
            version: { number: '1.21.1', type: 'release' },
            overrides: { detached: false },
            ...modalityConfig
        };

        const launcher = new Client();
        launcher.launch(finalOptions);

        launcher.on('data', (e) => {
            if (e.includes('Rendido!')) {
                startTimestamp = new Date();
                const playerState = serverStatus && serverStatus.online 
                    ? `(${serverStatus.players.online}/${serverStatus.players.max} jugadores)` 
                    : 'Explorando mundos 🌎';
                setActivity(`Jugando ${options.modality}`, playerState, 'firecraft_logo', 'minecraft_icon');
            }
            mainWindow.webContents.send('log', `[DATA] ${e}`);
        });

        launcher.on('debug', (e) => mainWindow.webContents.send('log', `[DEBUG] ${e}`));
        launcher.on('progress', (e) => mainWindow.webContents.send('progress', { type: e.type, task: e.task, total: e.total }));
        
        launcher.on('close', () => {
            isGameRunning = false;
            mainWindow.webContents.send('update-launch-button', isGameRunning);
            mainWindow.webContents.send('progress', {});
            
            startTimestamp = new Date();
            setActivity('En el launcher', 'Eligiendo una modalidad...');
        });

    } catch (error) {
        console.error('Error en el proceso de lanzamiento:', error);
        mainWindow.webContents.send('log', `[ERROR] ${error.message}`);
        isGameRunning = false;
        mainWindow.webContents.send('update-launch-button', isGameRunning);
        
        startTimestamp = new Date();
        setActivity('En el launcher', 'Ocurrió un error');
    }
});

// ==========================================================
//      FIN: GESTIÓN DE EVENTOS DE LA INTERFAZ
// ==========================================================


async function checkForModpackUpdate(modality, event) {
    if (modality !== 'firemods-neoforge') return;
    const remoteVersionUrl = 'https://firemods.net/storage/Modpacks/version.json';
    const localVersionPath = path.join(minecraftPath, 'firecraft_version.json');
    let localVersion = null;

    try {
        if (fs.existsSync(localVersionPath)) {
            localVersion = JSON.parse(fs.readFileSync(localVersionPath, 'utf-8')).installedVersion;
        }
    } catch (error) { localVersion = null; }

    try {
        event.sender.send('log', '[INFO] Verificando versión del modpack...');
        const response = await axios.get(remoteVersionUrl, { timeout: 5000 });
        const remoteVersion = response.data.version;
        const modpackUrl = response.data.downloadUrl;

        if (localVersion === remoteVersion) {
            event.sender.send('log', '[INFO] El modpack ya está actualizado.');
            return;
        }

        event.sender.send('log', `[INFO] Actualizando a v${remoteVersion}...`);
        await downloadModalityFiles(modpackUrl, event);
        fs.writeFileSync(localVersionPath, JSON.stringify({ installedVersion: remoteVersion }));
        event.sender.send('log', '[INFO] Modpack actualizado.');
    } catch (error) {
        event.sender.send('log', '[WARN] No se pudo conectar con el servidor de actualizaciones.');
    }
}


async function getLaunchConfigForModality(modality, rootPath, event) {
    const MINECRAFT_VERSION = '1.21.1';
    switch (modality) {
        case 'firemods-neoforge': {
            const neoforgeVersion = '21.1.174';
            const installerName = `neoforge-${neoforgeVersion}-installer.jar`;
            const installerPath = path.join(rootPath, installerName);

            if (!fs.existsSync(installerPath)) {
                event.sender.send('progress', { type: 'Descargando Instalador...', task: 1, total: 1 });
                const installerUrl = `https://maven.neoforged.net/net/neoforged/neoforge/${neoforgeVersion}/neoforge-${neoforgeVersion}-installer.jar`;
                const dl = new DownloaderHelper(installerUrl, rootPath, { override: true, fileName: installerName });
                await dl.start();
            }
            return { forge: installerPath };
        }
        case 'fabric':
            return await fabric.getMCLCLaunchConfig({ gameVersion: MINECRAFT_VERSION, rootPath: rootPath });
        case 'vanilla':
        default:
            return {};
    }
}


async function downloadModalityFiles(modpackUrl, event) {
    const zipPath = path.join(minecraftPath, 'modpack_temp.zip');
    const modsPath = path.join(minecraftPath, 'mods');

    try {
        event.sender.send('progress', { type: 'Limpiando...', task: 1, total: 5 });
        if (fs.existsSync(modsPath)) fs.rmSync(modsPath, { recursive: true, force: true });
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

        event.sender.send('progress', { type: 'Descargando...', task: 2, total: 5 });
        const dl = new DownloaderHelper(modpackUrl, minecraftPath, { override: true, fileName: 'modpack_temp.zip' });
        
        dl.on('progress', (stats) => {
            event.sender.send('progress', { type: 'Descargando...', task: Math.floor(stats.progress), total: 100 });
        });
        await dl.start();

        event.sender.send('progress', { type: 'Extrayendo...', task: 3, total: 5 });
        await extract(zipPath, { dir: minecraftPath });

        event.sender.send('progress', { type: 'Verificando...', task: 4, total: 5 });
        if (!fs.existsSync(modsPath)) throw new Error("El ZIP no contiene la carpeta 'mods'.");

        event.sender.send('progress', { type: 'Finalizando...', task: 5, total: 5 });
        fs.unlinkSync(zipPath);
    } catch (error) {
        console.error('Error al descargar el modpack:', error);
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
        throw new Error('No se pudo instalar el modpack.');
    }
}