const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { Client, Authenticator } = require('minecraft-launcher-core');
const fs = require('fs');
const { DownloaderHelper } = require('node-downloader-helper');
const { autoUpdater } = require('electron-updater');
const extract = require('extract-zip');
const util = require('util');
const { exec } = require('child_process');
const axios = require('axios');
const Rpc = require('discord-rpc');
const find = require('find-process');

const execPromise = util.promisify(exec);

if (process.defaultApp) {
    if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient('firecraft', process.execPath, [path.resolve(process.argv[1])]);
    }
} else {
    app.setAsDefaultProtocolClient('firecraft');
}

const clientId = '1400661686792491171';
const serverIPs = {
    'firemods-neoforge': 'play.firemods.net',
    'vanilla': 'Proximamente....',
    'firelite-forge': 'Proximamente....'
};
let mainWindow;
let isGameRunning = false;
let isOnServer = false; // Se vuelve a usar esta variable con una lógica mejorada
let currentModality = null;
let activeMinecraftPath = null;
let authAbortController = null;

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
        const url = commandLine.find((arg) => arg.startsWith('firecraft://'));
        if (url) {
            handleUrl(url);
        }
    });
}

function handleUrl(url) {
    if (!mainWindow) return;
    try {
        const parsedUrl = new URL(url);
        const action = parsedUrl.hostname;
        const ip = parsedUrl.searchParams.get('ip');

        if (action === 'join' && ip) {
            mainWindow.webContents.send('show-and-launch', {
                serverIp: ip,
                modality: 'firemods-neoforge'
            });
        }
    } catch (e) {
        console.error("No se pudo parsear la URL del protocolo:", e);
    }
}
Rpc.register(clientId);
const rpc = new Rpc.Client({ transport: 'ipc' });
let startTimestamp;
let serverStatus = null;

function getMinecraftPathForModality(modality) {
    const userDataPath = app.getPath('userData');
    switch (modality) {
        case 'firemods-neoforge':
            return path.join(userDataPath, '.firemods-neoforge');
        case 'firelite-forge':
            return path.join(userDataPath, '.firelite-forge');
        case 'vanilla':
        default:
            return path.join(userDataPath, '.minecraft');
    }
}

ipcMain.on('update-server-status', (event, status) => {
    serverStatus = status;
    if (isGameRunning) {
        updateRpcWithCurrentStatus();
    }
});

ipcMain.on('activity-changed', (event, activity) => {
    if (!isGameRunning) {
        setActivity(activity.details, activity.state);
    }
});

// ========================================================================
// FUNCIÓN DE RICH PRESENCE (CORREGIDA CON LÓGICA DE isOnServer)
// ========================================================================
function updateRpcWithCurrentStatus() {
    if (!isGameRunning || !currentModality) return;

    // Si el jugador está dentro del servidor Y el servidor está online, muestra el contador
    if (isOnServer && serverStatus && serverStatus.online) {
        const playerState = `(${serverStatus.players.online}/${serverStatus.players.max} jugadores)`;
        const serverName = serverIPs[currentModality] || currentModality;
        setActivity(`Jugando en ${serverName}`, playerState, 'firecraft_logo', 'minecraft_icon');
    } else {
        // En cualquier otro caso (menú principal, servidor offline, etc.), muestra este estado
        setActivity(`Jugando ${currentModality}`, 'En el menú principal', 'firecraft_logo', 'minecraft_icon');
    }
}

async function setActivity(details, state, largeImageKey = 'firecraft_logo', smallImageKey = 'minecraft_icon') {
    if (!rpc || !mainWindow) return;

    const activityPayload = {
        details: details,
        state: state,
        startTimestamp,
        largeImageKey: largeImageKey,
        largeImageText: 'FireCraft Launcher',
        instance: false,
    };

    const buttons = [{ label: 'Descargar Launcher', url: 'https://firemods.net/storage/Modpacks/launcher.zip' }];
    if (isGameRunning && isOnServer) { // Botón de unirse solo si estás en el servidor
        buttons.push({ label: 'Unirse al Servidor', url: 'firecraft://join?ip=play.firemods.net' });
    }
    activityPayload.buttons = buttons;

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

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 850,
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

    const url = process.argv.find((arg) => arg.startsWith('firecraft://'));
    if (url) {
        mainWindow.webContents.once('did-finish-load', () => {
            handleUrl(url);
        });
    }
}

app.whenReady().then(() => {
    createWindow();
    connectToDiscord();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

ipcMain.on('microsoft-login-start', async (event) => {
    if (authAbortController) {
        authAbortController.abort();
    }
    authAbortController = new AbortController();
    const signal = authAbortController.signal;

    event.sender.send('log', '[INFO] Iniciando flujo de autenticación por código de dispositivo...');

    try {
        const auth = await Authenticator.getAuth('microsoft', signal, (data) => {
            if (data.type === 'device_code') {
                event.sender.send('log', `[INFO] Código de dispositivo recibido: ${data.user_code}`);
                event.sender.send('microsoft-device-code', data);
            }
        });
        event.sender.send('log', `[INFO] Autenticación completada para ${auth.name}`);
        event.sender.send('microsoft-login-success', { name: auth.name, uuid: auth.uuid });
    } catch (error) {
        if (error.name === 'AbortError') {
            event.sender.send('log', '[INFO] El usuario canceló el inicio de sesión.');
        } else {
            console.error('Fallo en el inicio de sesión de Microsoft:', error);
            event.sender.send('log', `[ERROR] Fallo en el inicio de sesión de Microsoft: ${error.message}`);
            event.sender.send('microsoft-login-failed', { message: error.message });
        }
    } finally {
        authAbortController = null;
    }
});

ipcMain.on('microsoft-login-cancel', () => {
    if (authAbortController) {
        authAbortController.abort();
        authAbortController = null;
    }
});

ipcMain.on('microsoft-logout', (event) => {
    const accountCachePath = path.join(app.getPath('userData'), 'mclc_microsoft_accounts.json');
    try {
        if (fs.existsSync(accountCachePath)) {
            fs.unlinkSync(accountCachePath);
            event.sender.send('log', '[INFO] Sesión de Microsoft cerrada. Se ha borrado el caché.');
        }
    } catch (error) {
        console.error('No se pudo borrar el caché de la cuenta de Microsoft:', error);
        event.sender.send('log', '[ERROR] No se pudo borrar el caché de la cuenta.');
    }
});

async function verifyJava(event) {
    event.sender.send('log', '[INFO] Verificando instalación de Java...');
    try {
        const { stdout, stderr } = await execPromise('java -version');
        const output = stderr || stdout;
        if (output.includes('version "21.') || output.includes('version 21.')) {
            event.sender.send('log', '[INFO] Java 21 encontrado.');
            return true;
        } else {
            event.sender.send('log', `[WARN] Se encontró una versión de Java, pero no es la 21.`);
            return false;
        }
    } catch (error) {
        event.sender.send('log', '[WARN] Java no está instalado o no está en el PATH.');
        return false;
    }
}

ipcMain.on('install-java', async (event) => {
    event.sender.send('log', '[INFO] Iniciando descarga de Java 21...');
    const javaInstallerUrl = 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.4%2B7/OpenJDK21U-jdk_x64_windows_hotspot_21.0.4_7.msi';
    const tempPath = app.getPath('temp');
    const installerName = 'OpenJDK21-installer.msi';
    const installerPath = path.join(tempPath, installerName);

    const dl = new DownloaderHelper(javaInstallerUrl, tempPath, { override: true, fileName: installerName });

    dl.on('error', (err) => {
        event.sender.send('log', `[ERROR] No se pudo descargar Java: ${err.message}`);
        event.sender.send('java-install-failed');
    });

    dl.on('progress', (stats) => {
        event.sender.send('java-install-progress', { percentage: stats.progress.toFixed(2) });
    });

    dl.on('end', async () => {
        try {
            event.sender.send('java-install-progress', { text: 'Instalando... Esto puede tardar unos minutos.' });
            await execPromise(`msiexec /i "${installerPath}" /qn`);
            event.sender.send('log', '[INFO] Instalación de Java completada.');
            event.sender.send('java-install-finished');
        } catch (installError) {
            event.sender.send('log', `[ERROR] No se pudo instalar Java: ${installError.message}`);
            event.sender.send('java-install-failed');
        }
    });

    dl.start().catch(err => {
        event.sender.send('log', `[ERROR] No se pudo iniciar la descarga de Java: ${err.message}`);
        event.sender.send('java-install-failed');
    });
});

ipcMain.on('minimize-window', () => {
    if (mainWindow) {
        mainWindow.minimize();
    }
});

ipcMain.on('toggle-fullscreen', () => {
    if (mainWindow) {
        if (mainWindow.isMaximized()) {
            mainWindow.unmaximize();
        } else {
            mainWindow.maximize();
        }
    }
});

ipcMain.on('repair-installation', (event, { modality }) => {
    if (modality === 'vanilla') {
        event.sender.send('repair-finished', { success: false, error: 'La reparación no aplica a la modalidad Vanilla.' });
        return;
    }

    const minecraftPath = getMinecraftPathForModality(modality);
    const modsPath = path.join(minecraftPath, 'mods');
    const configPath = path.join(minecraftPath, 'config');
    const localVersionPath = path.join(minecraftPath, 'firecraft_version.json');

    try {
        event.sender.send('log', `[INFO] Iniciando reparación para ${modality}...`);
        if (fs.existsSync(modsPath)) fs.rmSync(modsPath, { recursive: true, force: true });
        if (fs.existsSync(configPath)) fs.rmSync(configPath, { recursive: true, force: true });
        if (fs.existsSync(localVersionPath)) fs.unlinkSync(localVersionPath);
        event.sender.send('repair-finished', { success: true });
    } catch (error) {
        console.error('Error durante la reparación:', error);
        event.sender.send('repair-finished', { success: false, error: error.message });
    }
});

ipcMain.on('open-folder', (event, { modality, folderType }) => {
    const basePath = getMinecraftPathForModality(modality);
    let targetFolder;

    if (folderType === 'shaders') {
        targetFolder = path.join(basePath, 'shaderpacks');
    } else if (folderType === 'resourcepacks') {
        targetFolder = path.join(basePath, 'resourcepacks');
    }

    if (targetFolder) {
        if (!fs.existsSync(targetFolder)) {
            fs.mkdirSync(targetFolder, { recursive: true });
        }
        shell.openPath(targetFolder);
    }
});

ipcMain.on('get-mods-list', (event, { modality }) => {
    const modsPath = path.join(getMinecraftPathForModality(modality), 'mods');
    if (!fs.existsSync(modsPath)) {
        event.sender.send('mods-list-response', []);
        return;
    }

    fs.readdir(modsPath, (err, files) => {
        if (err) {
            console.error('Error al leer la carpeta de mods:', err);
            event.sender.send('mods-list-response', []);
            return;
        }

        const mods = files.map(file => {
            if (file.endsWith('.jar') || file.endsWith('.jar.disabled')) {
                return {
                    name: file,
                    enabled: file.endsWith('.jar')
                };
            }
        }).filter(Boolean); 

        event.sender.send('mods-list-response', mods);
    });
});

ipcMain.on('toggle-mod-status', (event, { modality, mod }) => {
    const modsPath = path.join(getMinecraftPathForModality(modality), 'mods');
    const oldPath = path.join(modsPath, mod.name);
    const newName = mod.enabled ? `${mod.name}.disabled` : mod.name.replace('.disabled', '');
    const newPath = path.join(modsPath, newName);

    fs.rename(oldPath, newPath, (err) => {
        if (err) {
            console.error(`Error al renombrar el mod ${mod.name}:`, err);
        }
        event.sender.send('refresh-mods-list');
    });
});


function resetLauncherState() {
    isGameRunning = false;
    isOnServer = false;
    currentModality = null;
    activeMinecraftPath = null;
    if (mainWindow) {
        mainWindow.webContents.send('update-launch-button-state', 'idle');
        setActivity('En el launcher', 'Eligiendo una modalidad...');
    }
}

ipcMain.on('force-close-game', () => {
    if (!activeMinecraftPath) {
        resetLauncherState();
        return;
    }

    find('name', 'javaw.exe')
        .then(function (list) {
            let gameProcessFound = false;
            list.forEach(function (proc) {
                if (proc.cmd && proc.cmd.includes(activeMinecraftPath)) {
                    console.log(`[INFO] Proceso de Minecraft encontrado con PID: ${proc.pid}. Forzando cierre...`);
                    mainWindow.webContents.send('log', `[INFO] Proceso de Minecraft encontrado con PID: ${proc.pid}. Forzando cierre...`);
                    gameProcessFound = true;
                    try {
                        process.kill(proc.pid, 'SIGKILL');
                    } catch (e) {
                        console.error(`[ERROR] No se pudo terminar el proceso ${proc.pid}:`, e);
                        mainWindow.webContents.send('log', `[ERROR] No se pudo terminar el proceso ${proc.pid}: ${e.message}`);
                    }
                }
            });

            if (!gameProcessFound) {
                console.warn('[WARN] No se encontró ningún proceso de javaw.exe que coincidiera con la ruta del juego.');
                mainWindow.webContents.send('log', '[WARN] No se encontró un proceso de juego para cerrar.');
            }
        })
        .catch(function (err) {
            console.error('[ERROR] Error al buscar procesos:', err);
            mainWindow.webContents.send('log', `[ERROR] Error al buscar procesos: ${err.stack}`);
        })
        .finally(function () {
            resetLauncherState();
        });
});


ipcMain.on('launch-minecraft', async (event, options) => {
    if (isGameRunning) return;

    const javaReady = await verifyJava(event);
    if (!javaReady) {
        event.sender.send('java-not-found');
        return;
    }

    const minecraftPath = getMinecraftPathForModality(options.modality);
    activeMinecraftPath = minecraftPath;

    if (!fs.existsSync(minecraftPath)) {
        fs.mkdirSync(minecraftPath, { recursive: true });
    }

    isGameRunning = true;
    currentModality = options.modality;
    mainWindow.webContents.send('update-launch-button-state', 'launching');
    
    try {
        await checkForModpackUpdate(options.modality, event, minecraftPath);

        let auth;
        if (options.loginType === 'premium') {
            event.sender.send('log', '[INFO] Usando la sesión de Microsoft cacheada...');
            auth = await Authenticator.getAuth('microsoft');
        } else { 
            event.sender.send('log', `[INFO] Iniciando sesión offline con el usuario: ${options.username}`);
            auth = await Authenticator.getAuth(options.username);
        }
        
        const modalityConfig = await getLaunchConfigForModality(options.modality, minecraftPath, event, options);
        
        let gameArguments = [];
        if(options.serverIp) {
            gameArguments.push('--server', options.serverIp, '--port', '25565');
        }

        const finalOptions = {
            root: minecraftPath,
            authorization: auth,
            memory: options.memory,
            version: modalityConfig.version,
            forge: modalityConfig.forge,
            overrides: {
                detached: false,
                gameArguments: gameArguments,
            }
        };

        const launcher = new Client();
        
        launcher.launch(finalOptions);

        startTimestamp = new Date();
        setActivity(`Jugando ${currentModality}`, `Cargando...`);
        
        let gameStartedEmitted = false; 
        
        // ========================================================================
        // DETECCIÓN DE CONEXIÓN/DESCONEXIÓN (LÓGICA MEJORADA)
        // ========================================================================
        const joinPatterns = ['Joining multiplayer world', 'Server brand is', '[CHAT]'];
        const leavePatterns = ['disconnect', 'stopping!', 'returning to title screen'];

        launcher.on('data', (e) => {
            if (!gameStartedEmitted) {
                gameStartedEmitted = true;
                mainWindow.webContents.send('update-launch-button-state', 'running');
            }
            const logLine = e.toString();
            const logLineLower = logLine.toLowerCase();

            if (!isOnServer) {
                if (joinPatterns.some(pattern => logLine.includes(pattern))) {
                    isOnServer = true;
                    mainWindow.webContents.send('log', '[INFO] Conexión al servidor detectada.');
                    updateRpcWithCurrentStatus();
                }
            }
            
            if (isOnServer) {
                if (leavePatterns.some(pattern => logLineLower.includes(pattern))) {
                    isOnServer = false;
                    mainWindow.webContents.send('log', '[INFO] Desconexión del servidor detectada.');
                    updateRpcWithCurrentStatus();
                }
            }

            mainWindow.webContents.send('log', `[DATA] ${e}`);
        });

        launcher.on('debug', (e) => mainWindow.webContents.send('log', `[DEBUG] ${e}`));
        launcher.on('progress', (e) => mainWindow.webContents.send('progress', { type: e.type, task: e.task, total: e.total }));

        launcher.on('close', (code) => {
            if (!isGameRunning) return;
            mainWindow.webContents.send('log', `[INFO] El proceso del juego terminó con código: ${code}`);
            resetLauncherState();
        });
        
    } catch (error) {
        console.error('Error en el proceso de lanzamiento:', error);
        mainWindow.webContents.send('log', `[FATAL] Error en el proceso de lanzamiento: ${error.message}`);
        resetLauncherState();
    }
});


async function checkForModpackUpdate(modality, event, minecraftPath) {
    if (modality !== 'firemods-neoforge' && modality !== 'firelite-forge') {
        return;
    }

    const remoteInfoUrl = 'https://firemods.net/storage/Modpacks/launcher_info.json';
    const localVersionPath = path.join(minecraftPath, 'firecraft_version.json');

    try {
        event.sender.send('log', `[INFO] Verificando versión del modpack para ${modality}...`);

        const response = await axios.get(remoteInfoUrl, { timeout: 5000 });
        const remoteInfo = response.data;

        if (!remoteInfo[modality]) {
            event.sender.send('log', `[INFO] La modalidad ${modality} no tiene un modpack definido.`);
            return;
        }

        const modpackInfo = remoteInfo[modality];
        const remoteVersion = modpackInfo.version;
        const modpackUrl = modpackInfo.downloadUrl;

        let localVersions = {};
        if (fs.existsSync(localVersionPath)) {
            localVersions = JSON.parse(fs.readFileSync(localVersionPath, 'utf-8'));
        }
        const localVersion = localVersions[modality];

        if (localVersion === remoteVersion) {
            event.sender.send('log', '[INFO] El modpack ya está actualizado.');
            return;
        }

        event.sender.send('log', `[INFO] Nueva versión de ${modality} detectada. Actualizando...`);
        await downloadModalityFiles(modpackUrl, event, minecraftPath);

        localVersions[modality] = remoteVersion;
        fs.writeFileSync(localVersionPath, JSON.stringify(localVersions, null, 2));
        event.sender.send('log', `[INFO] Modpack ${modality} actualizado a la versión ${remoteVersion}.`);

    } catch (error) {
        event.sender.send('log', `[WARN] No se pudo verificar la versión del modpack: ${error.message}`);
    }
}

async function getLaunchConfigForModality(modality, rootPath, event, options) {
    switch (modality) {
        case 'firemods-neoforge': {
            const mcVersion = '1.21.1';
            const neoforgeVersion = '21.1.174';
            const installerName = `neoforge-${neoforgeVersion}-installer.jar`;
            const installerPath = path.join(rootPath, installerName);

            if (!fs.existsSync(installerPath)) {
                event.sender.send('progress', { type: 'Descargando Instalador NeoForge...', task: 1, total: 1 });
                const installerUrl = `https://maven.neoforged.net/net/neoforged/neoforge/${neoforgeVersion}/neoforge-${neoforgeVersion}-installer.jar`;
                const dl = new DownloaderHelper(installerUrl, rootPath, { override: true, fileName: installerName });
                await dl.start();
            }
            return {
                forge: installerPath,
                version: { number: mcVersion, type: 'release' }
            };
        }
        case 'firelite-forge': {
            const mcVersion = '1.20.1';
            const forgeVersion = '47.4.0';
            const installerName = `forge-${mcVersion}-${forgeVersion}-installer.jar`;
            const installerPath = path.join(rootPath, installerName);

            if (!fs.existsSync(installerPath)) {
                event.sender.send('progress', { type: 'Descargando Instalador Forge...', task: 1, total: 1 });
                
                const installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${mcVersion}-${forgeVersion}/forge-${mcVersion}-${forgeVersion}-installer.jar`;
                
                const dl = new DownloaderHelper(installerUrl, rootPath, { override: true, fileName: installerName });
                
                dl.on('error', err => event.sender.send('log', `[ERROR] Falló la descarga del instalador de Forge: ${err.message}`));
                await dl.start();
            }
            return {
                forge: installerPath,
                version: { number: mcVersion, type: 'release' }
            };
        }
        case 'vanilla':
        default:
            const vanillaVersion = options.vanillaVersion || '1.21.1';
            return {
                version: { number: vanillaVersion, type: 'release' }
            };
    }
}


async function downloadModalityFiles(modpackUrl, event, minecraftPath) {
    const zipPath = path.join(minecraftPath, 'modpack_temp.zip');
    const modsPath = path.join(minecraftPath, 'mods');
    const configPath = path.join(minecraftPath, 'config'); 
    try {
        event.sender.send('progress', { type: 'Limpiando...', task: 1, total: 5 });
        
        if (fs.existsSync(modsPath)) fs.rmSync(modsPath, { recursive: true, force: true });
        
        if (fs.existsSync(configPath)) fs.rmSync(configPath, { recursive: true, force: true });
        
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