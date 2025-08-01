const { ipcRenderer, shell } = require('electron');
const fs = require('fs');
const path = require('path');

document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));

        btn.classList.add('active');
        document.getElementById(btn.getAttribute('data-tab')).classList.add('active');
    });
});

document.getElementById('launch-button').addEventListener('click', function(event) {
    const username = document.getElementById('username').value;
    const minMemory = document.getElementById('min-memory').value + 'G';
    const maxMemory = document.getElementById('max-memory').value + 'G';
    const modality = document.getElementById('modality-select').value;

    localStorage.setItem('username', username);

    ipcRenderer.send('launch-minecraft', {
        username: username,
        memory: {
            min: minMemory,
            max: maxMemory
        },
        modality: modality
    });
});

document.querySelector('.titlebar-button.close').addEventListener('click', () => {
    window.close();
});

document.querySelector('.titlebar-button.minimize').addEventListener('click', () => {
    ipcRenderer.send('minimize-window');
});

document.addEventListener('DOMContentLoaded', () => {
    const savedUsername = localStorage.getItem('username');
    if (savedUsername) {
        document.getElementById('username').value = savedUsername;
    }

    const savedMinMemory = localStorage.getItem('minMemory');
    if (savedMinMemory) {
        document.getElementById('min-memory').value = savedMinMemory;
        document.getElementById('min-memory-value').textContent = savedMinMemory + 'G';
    }

    const savedMaxMemory = localStorage.getItem('maxMemory');
    if (savedMaxMemory) {
        document.getElementById('max-memory').value = savedMaxMemory;
        document.getElementById('max-memory-value').textContent = savedMaxMemory + 'G';
    }

    const fetchUpdateNotes = async () => {
        try {
            const response = await fetch('https://files.shukketsu.app/update-notes.html');
            if (!response.ok) throw new Error('Network response was not ok');
            const data = await response.text();
            document.getElementById('notes').innerHTML = data;
        } catch (error) {
            console.error('Error fetching the text file:', error);
            document.getElementById('notes').innerText = 'Failed to load content.';
        }
    };
    fetchUpdateNotes();
    
    const fetchOnlineStatus = async () => {
        try {
            const response = await fetch('https://api.mcsrvstat.us/3/play.firemods.net');
            if (!response.ok) throw new Error('Network response was not ok');
            const data = await response.json();
            
            // Actualizar la UI
            const onlineStatus = data.online ? `${data.players.online}/${data.players.max}` : 'Offline';
            document.querySelector('.profile-section p').textContent = `Conectados: ${onlineStatus}`;

            // <-- AÑADIDO: Enviar estado al proceso principal para Discord RPC
            if(data.online) {
                ipcRenderer.send('update-server-status', data);
            }

        } catch (error) {
            console.error('Error fetching the online status:', error);
            document.querySelector('.profile-section p').textContent = 'Conectados: N/A';
        }
    };
    fetchOnlineStatus();
    setInterval(fetchOnlineStatus, 20000);

    const launchButton = document.getElementById('launch-button');
    ipcRenderer.on('update-launch-button', (event, isGameRunning) => {
        launchButton.disabled = isGameRunning;
        launchButton.classList.toggle('disabled', isGameRunning);
        launchButton.textContent = isGameRunning ? 'Juego iniciado...' : 'Iniciar Minecraft';
    });

    // --- Lógica de la ventana modal de bienvenida ---
    const welcomeModal = document.getElementById('welcome-modal');
    const closeModalBtn = document.getElementById('close-modal-btn');
    const understandBtn = document.getElementById('modal-understand-btn');

    const closeModal = () => {
        welcomeModal.style.display = 'none';
        localStorage.setItem('hasSeenWelcomeModal', 'true');
    };

    if (!localStorage.getItem('hasSeenWelcomeModal')) {
        welcomeModal.style.display = 'flex';
    }

    closeModalBtn.addEventListener('click', closeModal);
    understandBtn.addEventListener('click', closeModal);

    // Opcional: Cerrar al hacer clic fuera del contenido
    welcomeModal.addEventListener('click', (event) => {
        if (event.target === welcomeModal) {
            closeModal();
        }
    });
});

document.getElementById('min-memory').addEventListener('input', function () {
    const minMemoryValue = this.value + 'G';
    document.getElementById('min-memory-value').textContent = minMemoryValue;
    localStorage.setItem('minMemory', this.value);
});

document.getElementById('max-memory').addEventListener('input', function () {
    const maxMemoryValue = this.value + 'G';
    document.getElementById('max-memory-value').textContent = maxMemoryValue;
    localStorage.setItem('maxMemory', this.value);
});

ipcRenderer.on('progress', (event, progress) => {
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');
    const progressContainer = document.getElementById('progress-container');

    if (progress.total && progress.task) {
        const percentage = (progress.task / progress.total) * 100;
        progressBar.style.width = `${percentage}%`;
        progressText.textContent = `${progress.type}: ${progress.task}/${progress.total} (${percentage.toFixed(2)}%)`;
        progressContainer.style.display = 'block';
    } else {
        progressContainer.style.display = 'none';
    }
});

ipcRenderer.on('update_available', () => {
    document.getElementById('update-notification').style.display = 'block';
});

ipcRenderer.on('update-progress', (event, percent) => {
    const updateProgressBar = document.getElementById('update-progress-bar');
    const updateProgressText = document.getElementById('update-progress-text');
    updateProgressBar.style.width = `${percent}%`;
    updateProgressText.textContent = `Update downloading: ${percent.toFixed(2)}%`;
    document.getElementById('update-progress-container').style.display = 'block';
});

ipcRenderer.on('update_downloaded', () => {
    document.getElementById('restart-button').style.display = 'block';
});

ipcRenderer.on('log', (event, message) => {
    const logOutput = document.getElementById('log-output');
    logOutput.textContent += message + '\n';
    logOutput.scrollTop = logOutput.scrollHeight;
});

document.getElementById('restart-button').addEventListener('click', () => {
    ipcRenderer.send('restart_app');
});

document.querySelectorAll('#credits a').forEach(link => {
    link.addEventListener('click', (event) => {
        event.preventDefault();
        shell.openExternal(link.href);
    });
});