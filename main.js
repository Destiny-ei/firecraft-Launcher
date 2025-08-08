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
    'vanilla': 'Proximamente....'
};
let mainWindow;
let isGameRunning = false;
let isOnServer = false;
let currentModality = null;
let activeMinecraftPath = null;

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
        case 'vanilla':
        default:
            return path.join(userDataPath, '.minecraft');
    }
}

ipcMain.on('activity-changed', (event, activity) => {
    if (!isGameRunning) {
        setActivity(activity.details, activity.state);
    }
});

function updateRpcWithCurrentStatus() {
    if (!isGameRunning || !currentModality) return;

    if (isOnServer) {
        const playerState = serverStatus && serverStatus.online
            ? `(${serverStatus.players.online}/${serverStatus.players.max} jugadores)`
            : 'En el servidor';
        const serverName = serverIPs[currentModality] || currentModality;
        setActivity(`Jugando en ${serverName}/${currentModality}`, playerState, 'firecraft_logo', 'minecraft_icon');
    } else {
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

    const buttons = [{ label: 'Descargar Launcher', url: 'https://firemods.net/storage/Modpacks/Setup-FireCraft.exe' }];
    if (isGameRunning) {
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

ipcMain.on('restart_app', () => {
    app.quit();
});

// --- Server Status Handling ---
let statusInterval;
let isFetchingStatus = false;

function fetchAndSendStatus(modality) {
    if (isFetchingStatus || !mainWindow) {
        return;
    }
    isFetchingStatus = true;

    const serverIp = serverIPs[modality];
    if (!serverIp || serverIp === 'Proximamente....') {
        const status = { online: false, customMessage: 'Servidor no disponible' };
        mainWindow.webContents.send('server-status-update', status);
        serverStatus = null;
        updateRpcWithCurrentStatus();
        isFetchingStatus = false;
        return;
    }
    
    axios.get(`https://api.mcsrvstat.us/3/${serverIp}`, { timeout: 4500 })
        .then(response => {
            if (response.data && typeof response.data.online !== 'undefined') {
                const statusData = response.data;
                mainWindow.webContents.send('server-status-update', statusData);
                serverStatus = statusData;
                updateRpcWithCurrentStatus();
            } else {
                throw new Error("Respuesta de API inválida de mcsrvstat.us");
            }
        })
        .catch(error => {
            console.error(`Error fetching status for ${serverIp}:`, error.message);
            const status = { online: false, customMessage: 'Servidor Offline' };
            mainWindow.webContents.send('server-status-update', status);
            serverStatus = null;
            updateRpcWithCurrentStatus();
        })
        .finally(() => {
            isFetchingStatus = false;
        });
}

ipcMain.on('request-server-status', (event, { modality }) => {
    if (statusInterval) clearInterval(statusInterval);
    
    fetchAndSendStatus(modality);
    
    statusInterval = setInterval(() => fetchAndSendStatus(modality), 5000);
});
// --- End of Server Status Handling ---


async function findJava(event) {
    event.sender.send('log', '[INFO] Buscando una instalación de Java 21...');
    const javaExe = process.platform === 'win32' ? 'java.exe' : 'java';

    try {
        const { stdout, stderr } = await execPromise(`${javaExe} -version`);
        const output = stderr || stdout;
        if (output.includes('version "21.') || output.includes('version 21.')) {
            event.sender.send('log', `[INFO] Java 21 encontrado en el PATH del sistema.`);
            return javaExe;
        }
    } catch (e) {
        // Ignorar, Java podría no estar en el PATH
    }

    const searchPaths = [];
    if (process.platform === 'win32') {
        const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
        const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
        searchPaths.push(
            path.join(programFiles, 'Java'),
            path.join(programFiles, 'Eclipse Adoptium'),
            path.join(programFiles, 'Semeru'),
            path.join(programFilesX86, 'Java')
        );
        if (process.env.JAVA_HOME) searchPaths.unshift(process.env.JAVA_HOME);
    } else if (process.platform === 'darwin') {
        searchPaths.push('/Library/Java/JavaVirtualMachines');
        if (process.env.JAVA_HOME) searchPaths.unshift(path.join(process.env.JAVA_HOME, 'Contents', 'Home'));
    } else {
        searchPaths.push('/usr/lib/jvm');
        if (process.env.JAVA_HOME) searchPaths.unshift(process.env.JAVA_HOME);
    }

    for (const searchPath of searchPaths) {
        if (!fs.existsSync(searchPath)) continue;
        const subdirs = fs.readdirSync(searchPath);
        for (const subdir of subdirs) {
            if (subdir.includes('21')) {
                const javaPath = path.join(searchPath, subdir, 'bin', javaExe);
                const macJavaPath = path.join(searchPath, subdir, 'Contents', 'Home', 'bin', javaExe);
                if (fs.existsSync(javaPath)) {
                     event.sender.send('log', `[INFO] Java 21 encontrado en: ${javaPath}`);
                     return `"${javaPath}"`;
                }
                if (fs.existsSync(macJavaPath)) {
                    event.sender.send('log', `[INFO] Java 21 encontrado en: ${macJavaPath}`);
                    return `"${macJavaPath}"`;
                }
            }
        }
    }

    event.sender.send('log', '[WARN] No se encontró una instalación de Java 21.');
    return null;
}


ipcMain.on('install-java', async (event) => {
    const platform = process.platform;
    let downloadUrl = '';
    let fileName = '';
    
    event.sender.send('log', `[INFO] Iniciando descarga de Java 21 para ${platform}...`);
    
    if (platform === 'win32') {
        downloadUrl = 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.4%2B7/OpenJDK21U-jdk_x64_windows_hotspot_21.0.4_7.msi';
        fileName = 'OpenJDK21-installer.msi';
    } else if (platform === 'darwin') {
        downloadUrl = 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.4%2B7/OpenJDK21U-jdk_x64_mac_hotspot_21.0.4_7.pkg';
        fileName = 'OpenJDK21-installer.pkg';
    } else {
        event.sender.send('log', '[ERROR] La instalación automática no está soportada en Linux desde el launcher.');
        event.sender.send('java-install-failed', { message: 'Instalación automática no soportada en Linux.' });
        return;
    }

    const tempPath = app.getPath('temp');
    const installerPath = path.join(tempPath, fileName);

    const dl = new DownloaderHelper(downloadUrl, tempPath, { override: true, fileName: fileName });

    dl.on('error', (err) => {
        event.sender.send('log', `[ERROR] No se pudo descargar Java: ${err.message}`);
        event.sender.send('java-install-failed', { message: 'Falló la descarga del instalador de Java.' });
    });

    dl.on('progress', (stats) => {
        event.sender.send('java-install-progress', { percentage: stats.progress.toFixed(2) });
    });

    dl.on('end', async () => {
        try {
            if (platform === 'win32') {
                event.sender.send('java-install-progress', { text: 'Descarga completa. Abriendo instalador...' });
                shell.openPath(installerPath);
                event.sender.send('java-install-progress', { text: 'Por favor, completa la instalación de Java y luego cierra y vuelve a abrir el launcher.' });

            } else if (platform === 'darwin') {
                 event.sender.send('java-install-progress', { text: 'Instalando... Se te pedirá la contraseña de administrador.' });
                 await execPromise(`sudo installer -pkg "${installerPath}" -target /`);
            }
            
            event.sender.send('java-install-finished');

        } catch (installError) {
            event.sender.send('log', `[ERROR] No se pudo abrir/instalar Java: ${installError.message}`);
            event.sender.send('java-install-failed', { message: `Error al abrir el instalador: ${installError.message}` });
        }
    });

    dl.start().catch(err => {
        event.sender.send('log', `[ERROR] No se pudo iniciar la descarga de Java: ${err.message}`);
        event.sender.send('java-install-failed', { message: 'No se pudo iniciar la descarga de Java.' });
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

// UPDATED: Added 'mods' as a folderType
ipcMain.on('open-folder', (event, { modality, folderType }) => {
    const basePath = getMinecraftPathForModality(modality);
    let targetFolder;

    if (folderType === 'shaders') {
        targetFolder = path.join(basePath, 'shaderpacks');
    } else if (folderType === 'resourcepacks') {
        targetFolder = path.join(basePath, 'resourcepacks');
    } else if (folderType === 'mods') {
        targetFolder = path.join(basePath, 'mods');
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

    const javaPath = await findJava(event);
    if (!javaPath) {
        event.sender.send('java-not-found', { os: process.platform });
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

        const auth = await Authenticator.getAuth(options.username || "microsoft");
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
                javaPath: javaPath,
            }
        };

        const launcher = new Client();
        
        launcher.launch(finalOptions);

        startTimestamp = new Date();
        setActivity(`Jugando ${currentModality}`, `Cargando...`);
        
        let gameStartedEmitted = false; 
        launcher.on('data', (e) => {
            if (!gameStartedEmitted) {
                gameStartedEmitted = true;
                mainWindow.webContents.send('update-launch-button-state', 'running');
            }
            const logLine = e.toString();
            if (!isOnServer && logLine.includes('Joining multiplayer world')) {
                isOnServer = true;
                updateRpcWithCurrentStatus();
            }
            if (isOnServer && logLine.toLowerCase().includes('disconnect')) {
                isOnServer = false;
                updateRpcWithCurrentStatus();
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
    if (modality !== 'firemods-neoforge') {
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
