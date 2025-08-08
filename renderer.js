const { ipcRenderer, shell } = require('electron');

// --- LÓGICA PARA HACER FUNCIONAR LOS SELECTORES PERSONALIZADOS ---
function setupCustomSelects() {
    document.querySelectorAll('.custom-select-wrapper').forEach(wrapper => {
        const trigger = wrapper.querySelector('.custom-select-trigger');
        const optionsContainer = wrapper.querySelector('.custom-options');

        const selectedOption = optionsContainer.querySelector('.custom-option.selected');
        if (selectedOption) {
            trigger.querySelector('span').textContent = selectedOption.textContent;
            trigger.dataset.selectedValue = selectedOption.dataset.value;
        }

        trigger.addEventListener('click', () => {
            document.querySelectorAll('.custom-select-wrapper.open').forEach(openWrapper => {
                if (openWrapper !== wrapper) {
                    openWrapper.classList.remove('open');
                }
            });
            wrapper.classList.toggle('open');
        });

        optionsContainer.addEventListener('click', (e) => {
            if (e.target.classList.contains('custom-option')) {
                const option = e.target;
                if (optionsContainer.querySelector('.custom-option.selected')) {
                    optionsContainer.querySelector('.custom-option.selected').classList.remove('selected');
                }
                option.classList.add('selected');
                
                trigger.querySelector('span').textContent = option.textContent;
                trigger.dataset.selectedValue = option.dataset.value;
                
                wrapper.classList.remove('open');
                
                if (wrapper.id === 'modality-select-wrapper') {
                    wrapper.dispatchEvent(new Event('change'));
                }
            }
        });
    });

    window.addEventListener('click', (e) => {
        document.querySelectorAll('.custom-select-wrapper').forEach(wrapper => {
            if (!wrapper.contains(e.target)) {
                wrapper.classList.remove('open');
            }
        });
    });
}


document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));

        btn.classList.add('active');
        document.getElementById(btn.getAttribute('data-tab')).classList.add('active');

        ipcRenderer.send('activity-changed', { details: 'En el launcher', state: `Viendo la pestaña de ${btn.textContent}` });
    });
});

document.getElementById('launch-button').addEventListener('click', function(event) {
    const usernameInput = document.getElementById('username');
    const feedbackMessage = document.getElementById('feedback-message');
    const username = usernameInput.value.trim();

    if (username === '') {
        feedbackMessage.textContent = 'Por favor, introduce un nombre de usuario para continuar.';
        usernameInput.classList.add('input-error');
        return;
    }
    feedbackMessage.textContent = '';
    usernameInput.classList.remove('input-error');
    
    const minMemory = document.getElementById('min-memory').value + 'G';
    const maxMemory = document.getElementById('max-memory').value + 'G';
    const modality = document.getElementById('modality-select-wrapper').querySelector('.custom-select-trigger').dataset.selectedValue;
    
    const launchOptions = {
        username: username,
        memory: { min: minMemory, max: maxMemory },
        modality: modality
    };

    if (modality === 'vanilla') {
        launchOptions.vanillaVersion = document.getElementById('version-select-wrapper').querySelector('.custom-select-trigger').dataset.selectedValue;
    }

    localStorage.setItem('username', username);
    ipcRenderer.send('launch-minecraft', launchOptions);
});

document.getElementById('username').addEventListener('input', () => {
    document.getElementById('username').classList.remove('input-error');
    document.getElementById('feedback-message').textContent = '';
});

document.querySelector('.titlebar-button.close').addEventListener('click', () => {
    window.close();
});

document.querySelector('.titlebar-button.minimize').addEventListener('click', () => {
    ipcRenderer.send('minimize-window');
});

document.addEventListener('DOMContentLoaded', () => {
    setupCustomSelects(); 

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

    const modalitySelectWrapper = document.getElementById('modality-select-wrapper');
    const vanillaVersionGroup = document.getElementById('vanilla-version-group');

    // --- UPDATED: Server Status Logic ---
    const updateStatusForModality = () => {
        const selectedModality = modalitySelectWrapper.querySelector('.custom-select-trigger').dataset.selectedValue;
        ipcRenderer.send('request-server-status', { modality: selectedModality });
    };

    modalitySelectWrapper.addEventListener('change', () => {
        const selectedModality = modalitySelectWrapper.querySelector('.custom-select-trigger').dataset.selectedValue;
        if (selectedModality === 'vanilla') {
            vanillaVersionGroup.style.display = 'block';
        } else {
            vanillaVersionGroup.style.display = 'none';
        }
        updateStatusForModality();
    });
    
    ipcRenderer.on('server-status-update', (event, data) => {
        const statusElement = document.querySelector('.profile-section p');
        if (!data) {
            statusElement.textContent = 'Conectados: N/A';
            return;
        }
    
        if (data.customMessage) {
            statusElement.textContent = data.customMessage;
        } else if (data.online) {
            statusElement.textContent = `Conectados: ${data.players.online}/${data.players.max}`;
        } else {
            statusElement.textContent = 'Servidor Offline';
        }
    });

    // Initial call to get status for the default modality
    updateStatusForModality();
    // --- End of Server Status Logic ---

    const populateVersionSelector = async () => {
        const versionOptionsContainer = document.querySelector('#version-select-wrapper .custom-options');
        const versionTriggerSpan = document.querySelector('#version-select-wrapper .custom-select-trigger span');
        try {
            const response = await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
            const data = await response.json();
            const releaseVersions = data.versions.filter(v => v.type === 'release');
            
            versionOptionsContainer.innerHTML = '';
            
            releaseVersions.forEach((version, index) => {
                const optionDiv = document.createElement('div');
                optionDiv.classList.add('custom-option');
                optionDiv.dataset.value = version.id;
                optionDiv.textContent = version.id;
                
                if (index === 0) {
                    optionDiv.classList.add('selected');
                    versionTriggerSpan.textContent = version.id;
                    versionTriggerSpan.parentElement.dataset.selectedValue = version.id;
                }
                versionOptionsContainer.appendChild(optionDiv);
            });

        } catch (error) {
            console.error('Error al cargar las versiones de Minecraft:', error);
            versionTriggerSpan.textContent = 'Error al cargar';
        }
    };
    populateVersionSelector();

    const fetchNews = async () => {
        const notesContainer = document.getElementById('notes');
        try {
            const response = await fetch('https://firemods.net/storage/Modpacks/noticias.json'); 
            if (!response.ok) throw new Error('Network response was not ok');
            
            const newsItems = await response.json();
            
            let htmlContent = '';
            if (newsItems.length > 0) {
                newsItems.forEach(item => {
                    htmlContent += `
                        <div class="news-entry">
                            <h4>${item.title}</h4>
                            <span class="news-date">${item.date}</span>
                            <div class="news-content">${item.content}</div>
                        </div>
                    `;
                });
            } else {
                htmlContent = '<p>No hay noticias para mostrar.</p>';
            }
            notesContainer.innerHTML = htmlContent;

        } catch (error) {
            console.error('Error fetching news file:', error);
            notesContainer.innerText = 'No se pudieron cargar las noticias.';
        }
    };
    fetchNews();
    
    const launchButton = document.getElementById('launch-button');
    const forceCloseButton = document.getElementById('force-close-button');
    const progressContainer = document.getElementById('progress-container');

    forceCloseButton.addEventListener('click', () => {
        ipcRenderer.send('force-close-game');
    });
    
    ipcRenderer.on('update-launch-button-state', (event, state) => {
        launchButton.style.display = 'none';
        progressContainer.style.display = 'none';
        forceCloseButton.style.display = 'none';

        switch (state) {
            case 'running':
                forceCloseButton.style.display = 'block';
                break;
            case 'launching':
                progressContainer.style.display = 'block';
                break;
            case 'idle':
            default:
                launchButton.style.display = 'block';
                break;
        }
    });
    
    const welcomeModal = document.getElementById('welcome-modal');
    const closeModalBtn = document.getElementById('close-modal-btn');
    const understandBtn = document.getElementById('modal-understand-btn');

    const closeModal = () => {
        if (welcomeModal) welcomeModal.style.display = 'none';
        localStorage.setItem('hasSeenWelcomeModal', 'true');
    };

    if (!localStorage.getItem('hasSeenWelcomeModal') && welcomeModal) {
        welcomeModal.style.display = 'flex';
    }

    if(closeModalBtn) closeModalBtn.addEventListener('click', closeModal);
    if(understandBtn) understandBtn.addEventListener('click', closeModal);

    if (welcomeModal) {
        welcomeModal.addEventListener('click', (event) => {
            if (event.target === welcomeModal) closeModal();
        });
    }

    const repairButton = document.getElementById('repair-button');
    const repairFeedback = document.getElementById('repair-feedback');

    if (repairButton) {
        repairButton.addEventListener('click', () => {
            const modality = document.getElementById('modality-select-wrapper').querySelector('.custom-select-trigger').dataset.selectedValue;

            if (modality === 'vanilla') {
                alert('La función de reparación solo está disponible para las modalidades con mods (FireMods, FireLite).');
                return;
            }

            const confirmation = confirm(
                '¿Estás seguro de que quieres reparar la instalación?\n\n' +
                'Esto borrará tus mods y configuraciones actuales. Se volverán a descargar la próxima vez que inicies la modalidad seleccionada.'
            );
        
            if (confirmation) {
                repairFeedback.textContent = 'Reparando...';
                ipcRenderer.send('repair-installation', { modality: modality });
            }
        });
    }

    ipcRenderer.on('repair-finished', (event, { success, error }) => {
        if (repairFeedback) {
            if (success) {
                repairFeedback.textContent = '¡Reparación completada! Inicia el juego para reinstalar los archivos.';
            } else {
                repairFeedback.textContent = `Error en la reparación: ${error}`;
            }
            setTimeout(() => {
                if(repairFeedback) repairFeedback.textContent = '';
            }, 5000);
        }
    });

    document.getElementById('min-memory').addEventListener('input', function () {
        const value = this.value + 'G';
        document.getElementById('min-memory-value').textContent = value;
        localStorage.setItem('minMemory', this.value);
    });
    
    document.getElementById('max-memory').addEventListener('input', function () {
        const value = this.value + 'G';
        document.getElementById('max-memory-value').textContent = value;
        localStorage.setItem('maxMemory', this.value);
    });
    
    const restartButton = document.getElementById('restart-button');
    if (restartButton) {
        restartButton.addEventListener('click', () => {
            ipcRenderer.send('restart_app');
        });
    }
});

ipcRenderer.on('progress', (event, progress) => {
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');
    const progressContainer = document.getElementById('progress-container');

    if (progress.total && progress.task) {
        const percentage = (progress.task / progress.total) * 100;
        progressBar.style.width = `${percentage}%`;
        progressText.textContent = `${progress.type}: ${progress.task}/${progress.total} (${percentage.toFixed(2)}%)`;
    }
});

ipcRenderer.on('update_available', () => {
    const updateNotification = document.getElementById('update-notification');
    if(updateNotification) updateNotification.style.display = 'block';
});

ipcRenderer.on('update-progress', (event, percent) => {
    const updateProgressBar = document.getElementById('update-progress-bar');
    const updateProgressText = document.getElementById('update-progress-text');
    if(updateProgressBar) updateProgressBar.style.width = `${percent}%`;
    if(updateProgressText) updateProgressText.textContent = `Descargando actualización: ${percent.toFixed(2)}%`;
});

ipcRenderer.on('update_downloaded', () => {
    const restartButton = document.getElementById('restart-button');
    if(restartButton) restartButton.style.display = 'block';
});

ipcRenderer.on('log', (event, message) => {
    const logOutput = document.getElementById('log-output');
    if (logOutput) {
        logOutput.textContent += message + '\n';
        logOutput.scrollTop = logOutput.scrollHeight;
    }
});

document.querySelectorAll('#credits a').forEach(link => {
    link.addEventListener('click', (event) => {
        event.preventDefault();
        shell.openExternal(link.href);
    });
});

const javaModal = document.getElementById('java-install-modal');
const installJavaBtn = document.getElementById('install-java-btn');
const cancelJavaBtn = document.getElementById('cancel-java-btn');
const javaProgressContainer = document.getElementById('java-progress-container');
const javaProgressBar = document.getElementById('java-progress-bar');
const javaProgressText = document.getElementById('java-progress-text');
const javaModalButtons = document.getElementById('java-modal-buttons');
const javaLinuxInstructions = document.getElementById('java-linux-instructions');
const javaModalQuestion = document.getElementById('java-modal-question');
const restartJavaBtn = document.getElementById('restart-java-btn');


ipcRenderer.on('java-not-found', (event, { os }) => {
    if (os === 'linux') {
        javaLinuxInstructions.style.display = 'block';
        javaModalQuestion.style.display = 'none';
        installJavaBtn.style.display = 'none';
        cancelJavaBtn.textContent = 'Cerrar';
    } else {
        javaLinuxInstructions.style.display = 'none';
        javaModalQuestion.style.display = 'block';
        installJavaBtn.style.display = 'inline-block';
        cancelJavaBtn.textContent = 'No, gracias';
    }
    if (javaModal) javaModal.style.display = 'flex';
});

if (installJavaBtn) {
    installJavaBtn.addEventListener('click', () => {
        if(javaModalButtons) javaModalButtons.style.display = 'none';
        if(javaProgressContainer) javaProgressContainer.style.display = 'block';
        ipcRenderer.send('install-java');
    });
}

if (cancelJavaBtn) {
    cancelJavaBtn.addEventListener('click', () => {
        if (javaModal) javaModal.style.display = 'none';
    });
}

if (restartJavaBtn) {
    restartJavaBtn.addEventListener('click', () => {
        ipcRenderer.send('restart_app');
    });
}

ipcRenderer.on('java-install-progress', (event, { percentage, text }) => {
    if (percentage && javaProgressBar) {
        javaProgressBar.style.width = `${percentage}%`;
        javaProgressText.textContent = `Descargando... ${percentage.toFixed(2)}%`;
    }
    if (text && javaProgressText) {
        javaProgressText.textContent = text;
    }
});

ipcRenderer.on('java-install-finished', () => {
    if(javaProgressText) javaProgressText.textContent = '¡Instalación completa! Por favor, cierra y vuelve a abrir el launcher para continuar.';
    if(javaProgressContainer) javaProgressContainer.style.display = 'none';
    if(javaModalButtons) javaModalButtons.style.display = 'block';
    if(installJavaBtn) installJavaBtn.style.display = 'none';
    if(cancelJavaBtn) cancelJavaBtn.style.display = 'none';
    if(restartJavaBtn) {
        restartJavaBtn.textContent = 'Cerrar Launcher';
        restartJavaBtn.style.backgroundColor = 'var(--primary-red)';
        restartJavaBtn.style.display = 'inline-block';
    }
});

ipcRenderer.on('java-install-failed', (event, { message } = {}) => {
    const defaultMessage = 'La instalación falló. Revisa los logs para más detalles.';
    if(javaProgressText) javaProgressText.textContent = message || defaultMessage;
    
    if(javaProgressContainer) javaProgressContainer.style.display = 'none';
    if(javaModalButtons) javaModalButtons.style.display = 'block';
    if(installJavaBtn) installJavaBtn.style.display = 'inline-block';
    if(cancelJavaBtn) cancelJavaBtn.textContent = 'Cerrar';
});

ipcRenderer.on('show-and-launch', (event, { serverIp, modality }) => {
    const username = document.getElementById('username').value;
    if (!username) {
        alert("Por favor, introduce tu nombre de usuario antes de unirte.");
        return;
    }
    document.querySelector('.tab-btn[data-tab="play"]').click();
    
    const modalityWrapper = document.getElementById('modality-select-wrapper');
    const modalityTrigger = modalityWrapper.querySelector('.custom-select-trigger');
    const targetOption = modalityWrapper.querySelector(`.custom-option[data-value="${modality}"]`);
    if(targetOption) {
        modalityWrapper.querySelector('.custom-option.selected')?.classList.remove('selected');
        targetOption.classList.add('selected');
        modalityTrigger.querySelector('span').textContent = targetOption.textContent;
        modalityTrigger.dataset.selectedValue = modality;
    }

    const minMemory = document.getElementById('min-memory').value + 'G';
    const maxMemory = document.getElementById('max-memory').value + 'G';
    ipcRenderer.send('launch-minecraft', {
        username: username,
        memory: { min: minMemory, max: maxMemory },
        modality: modality,
        serverIp: serverIp
    });
});

const manageModalitySelect = document.getElementById('manage-modality-select');
const modsListContainer = document.getElementById('mods-list-container');
const openShadersBtn = document.getElementById('open-shaders-folder');
const openResourcePacksBtn = document.getElementById('open-resourcepacks-folder');
// NEW: Get the new button element
const openModsBtn = document.getElementById('open-mods-folder');

function fetchModsList() {
    const selectedModality = manageModalitySelect.value;
    if (!selectedModality) {
        modsListContainer.innerHTML = '<p>Selecciona una modalidad para ver los mods.</p>';
        return;
    }
    ipcRenderer.send('get-mods-list', { modality: selectedModality });
}

manageModalitySelect.addEventListener('change', fetchModsList);

document.querySelector('.tab-btn[data-tab="manage"]').addEventListener('click', fetchModsList);

ipcRenderer.on('mods-list-response', (event, mods) => {
    modsListContainer.innerHTML = ''; 

    if (!mods || mods.length === 0) {
        modsListContainer.innerHTML = '<p>No se encontraron mods en esta modalidad, o la carpeta no existe.</p>';
        return;
    }

    mods.forEach(mod => {
        const modItem = document.createElement('div');
        modItem.className = 'mod-item';

        const modName = document.createElement('span');
        modName.className = 'mod-name';
        modName.textContent = mod.name;
        
        const switchLabel = document.createElement('label');
        switchLabel.className = 'switch';
        
        const switchInput = document.createElement('input');
        switchInput.type = 'checkbox';
        switchInput.checked = mod.enabled;
        
        switchInput.addEventListener('change', () => {
            ipcRenderer.send('toggle-mod-status', { 
                modality: manageModalitySelect.value, 
                mod: mod 
            });
        });
        
        const sliderSpan = document.createElement('span');
        sliderSpan.className = 'slider';
        
        switchLabel.appendChild(switchInput);
        switchLabel.appendChild(sliderSpan);
        
        modItem.appendChild(modName);
        modItem.appendChild(switchLabel);
        
        modsListContainer.appendChild(modItem);
    });
});

ipcRenderer.on('refresh-mods-list', fetchModsList);

// NEW: Add event listener for the new button
openModsBtn.addEventListener('click', () => {
    ipcRenderer.send('open-folder', {
        modality: manageModalitySelect.value,
        folderType: 'mods'
    });
});

openShadersBtn.addEventListener('click', () => {
    ipcRenderer.send('open-folder', {
        modality: manageModalitySelect.value,
        folderType: 'shaders'
    });
});

openResourcePacksBtn.addEventListener('click', () => {
    ipcRenderer.send('open-folder', {
        modality: manageModalitySelect.value,
        folderType: 'resourcepacks'
    });
});
