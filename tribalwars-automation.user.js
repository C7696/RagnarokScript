// ==UserScript==
// @name         Ragnarok Script - 131
// @namespace    http://tampermonkey.net/
// @version      4.3
// @description  Script completo para Tribal Wars: Verificação de licença, gerenciamento de recrutamento e fila de construção fluida com atualizações automáticas. Sistema anti-loop com actionLock, cooldown por falha, persistência de estado por aldeia, contador de falhas consecutivas e bloqueio temporário de targets problemáticos.
// @author       Você
// @icon         https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRqZkx9l1oFSMXaHyoydMSRhtkyQjfvjovCIw&s
// @match        https://br131.tribalwars.com.br/*
// @grant        none
// @require      https://cdnjs.cloudflare.com/ajax/libs/Sortable/1.15.0/Sortable.min.js
// @updateURL    https://c7696.github.io/RagnarokScript/tribalwars-automation.user.js
// @downloadURL  https://c7696.github.io/RagnarokScript/tribalwars-automation.user.js
// ==/UserScript==































// Cria um elemento <style> para adicionar regras de CSS personalizadas à página.
const style = document.createElement('style');
style.textContent = `
    /* Container dos cartões com rolagem */
    #construction-orders-container {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 16px;
        padding: 10px;
        max-height: 400px; /* Limite de altura */
        overflow-y: auto; /* Rolagem vertical */
        background: linear-gradient(135deg, #f0f4f8, #d9e2ec);
        border: 2px solid #3498db;
        border-radius: 10px;
        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    }


    /* Estilo básico dos cartões */
    .draggable-card {
        position: relative;
        border: none;
        border-radius: 12px;
        padding: 16px;
        background: linear-gradient(135deg, #ffffff, #f9f9f9);
        box-shadow: 0 8px 16px rgba(0, 0, 0, 0.1);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        font-family: Arial, sans-serif;
        font-size: 14px;
        color: #2c3e50;
        cursor: grab;
        transition: transform 0.3s ease, box-shadow 0.3s ease;
    }


    /* Ícone do edifício */
    .draggable-card .icon {
        font-size: 40px;
        margin-bottom: 8px;
        color: #3498db;
    }


    /* Nome do edifício */
    .draggable-card .name {
        font-weight: bold;
        font-size: 16px;
        margin-bottom: 4px;
        color: #2c3e50;
        text-transform: capitalize;
    }


    /* Nível do edifício */
    .draggable-card .level {
        font-size: 14px;
        color: #7f8c8d;
    }


    /* Efeito ao passar o mouse */
    .draggable-card:hover {
        transform: translateY(-5px);
        box-shadow: 0 12px 24px rgba(0, 0, 0, 0.2);
        background: linear-gradient(135deg, #e3f2fd, #ffffff);
    }


    /* Botão de fechar e salvar */
    #save-order, #close-popup-orders {
        margin-top: 10px;
    }


    /* Scrollbar personalizada */
    #construction-orders-container::-webkit-scrollbar {
        width: 8px;
    }
    #construction-orders-container::-webkit-scrollbar-track {
        background: #f0f4f8;
        border-radius: 10px;
    }
    #construction-orders-container::-webkit-scrollbar-thumb {
        background: #3498db;
        border-radius: 10px;
    }
    #construction-orders-container::-webkit-scrollbar-thumb:hover {
        background: #2c81ba;
    }
`;
document.head.appendChild(style);










(function () {
    'use strict';


    // URLs para redirecionamento
    const urls = {
    "Edifício Principal": "screen=main",
    Recrutamento: "screen=train",
    Coleta: "screen=place&mode=scavenge_mass",
    Ferreiro: "screen=smith",
    "Criar ofertas": "screen=market&mode=mass_create_offers",
    "Aceitar ofertas": "screen=market&mode=other_offer&action=search",
    "Vender por pps": "screen=market&mode=exchange",
    Farm: "screen=am_farm",
    "Login Automático": "" // Aqui você pode adicionar o redirecionamento necessário
};




    // Configurações específicas de recrutamento
    let recruitmentConfig = {
        spear: 0,
        sword: 0,
        axe: 0,
        light: 0
    };


    // Lista de funções ativas
    let activeFunctions = [];


    // Salva as funções ativas no armazenamento local
    function saveActiveFunctions() {
        localStorage.setItem('activeFunctions', JSON.stringify(activeFunctions));
    }


    // Salva as configurações de recrutamento no armazenamento local
    function saveRecruitmentConfig() {
        localStorage.setItem('recruitmentConfig', JSON.stringify(recruitmentConfig));
    }


    // Carrega as funções ativas do armazenamento local
    function loadActiveFunctions() {
        const saved = localStorage.getItem('activeFunctions');
        if (saved) activeFunctions = JSON.parse(saved);
    }


    // Carrega as configurações de recrutamento do armazenamento local
    function loadRecruitmentConfig() {
        const saved = localStorage.getItem('recruitmentConfig');
        if (saved) recruitmentConfig = JSON.parse(saved);
    }


    // Função para criar pop-ups
    function createPopup(content) {
        const existingPopup = document.getElementById('custom-popup');
        if (existingPopup) existingPopup.remove();


        const popup = document.createElement('div');
        popup.id = 'custom-popup';
        popup.style.position = 'fixed';
        popup.style.top = '50%';
        popup.style.left = '50%';
        popup.style.transform = 'translate(-50%, -50%)';
        popup.style.backgroundColor = '#fff';
        popup.style.border = '2px solid #000';
        popup.style.boxShadow = '0 4px 8px rgba(0, 0, 0, 0.2)';
        popup.style.padding = '20px';
        popup.style.zIndex = '10000';
        popup.style.borderRadius = '8px';
        popup.style.fontFamily = 'Arial, sans-serif';
        popup.style.textAlign = 'center';
        popup.style.width = '400px';
        popup.innerHTML = content;


        document.body.appendChild(popup);
        return popup;
    }


    // Função para fechar o pop-up
    function closePopup() {
        const popup = document.getElementById('custom-popup');
        if (popup) popup.remove();
    }




























// Redireciona aleatoriamente para funções ativas
function redirectRandomly() {
    if (activeFunctions.length > 0) {
        const randomFunction = activeFunctions[Math.floor(Math.random() * activeFunctions.length)];


        // Verifica se o Login Automático está ativado antes de chamar a função
        if (randomFunction === "Login Automático" && activeFunctions.includes("Login Automático")) {
            performAutoLogin();
        } else {
            redirectTo(urls[randomFunction]);
        }
    }
}


// Função para realizar o login automático sempre que o botão estiver disponível
function performAutoLogin() {
    const worldButtons = document.querySelectorAll('span.world_button_active');


    for (const button of worldButtons) {
        if (button.textContent.trim() === 'Mundo 131') {
            button.click();
            console.log('Clicou no botão "Mundo 131"');
            return;
        }
    }


    console.log('Botão "Mundo 131" não encontrado');
}


// Inicia a automação de login ao carregar a página
window.addEventListener('load', performAutoLogin);






















    // Redireciona para uma URL específica
    // Redireciona para uma URL específica e simula o pressionamento da tecla "D"
function redirectTo(screen) {
    const villageId = new URLSearchParams(window.location.search).get('village');
    const url = `https://br131.tribalwars.com.br/game.php?village=${villageId}&${screen}`;
    const randomTime = Math.floor(Math.random() * 11 + 10) * 1000; // 10 a 20 segundos
    setTimeout(() => {
        window.location.href = url;
        // Aguarda o redirecionamento ser concluído antes de simular a tecla
        setTimeout(() => {
            const event = new KeyboardEvent('keydown', {
                key: 'd',
                code: 'KeyD',
                keyCode: 68,
                bubbles: true
            });
            document.dispatchEvent(event);
            console.log('Tecla "D" pressionada automaticamente após o redirecionamento.');
        }, 2000); // Pequeno atraso para garantir que a página esteja carregada
    }, randomTime);
}



    // Inicia o redirecionamento automático
    function startAutoRedirect() {
        if (activeFunctions.length > 0) {
            redirectRandomly();
        }
    }






// Função para remover a opção de "Login Automático" do pop-up
function showFunctionSelector() {
    const content = `
    <div style="font-family: 'Inter', sans-serif; max-width: 90%; margin: 0 auto; padding: 15px; background-color: #1e1e1e; border-radius: 15px; box-shadow: 0px 10px 20px rgba(0, 0, 0, 0.5); position: relative; color: #fff; transition: all 0.3s ease;">
        <header style="text-align: center; margin-bottom: 15px;">
            <h2 style="font-size: 20px; font-weight: bold; letter-spacing: 0.5px; background: linear-gradient(90deg, #ff8a00, #e52e71); -webkit-background-clip: text; color: transparent;">
                ⚙️ Configuração Personalizada
            </h2>
            <p style="font-size: 12px; color: #bbb; margin: 0;">Selecione e personalize as funções disponíveis.</p>
        </header>
        <form id="function-form" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px;">
            ${Object.keys(urls).filter(option => option !== "Login Automático").map(option => `
            <div style="background: #282828; padding: 10px; border-radius: 8px; display: flex; flex-direction: column; justify-content: space-between; align-items: flex-start; box-shadow: 0px 3px 10px rgba(0, 0, 0, 0.3); transition: transform 0.3s, background 0.3s;">
                <label style="font-size: 14px; font-weight: bold; display: flex; align-items: center; gap: 8px; margin-bottom: 10px;">
                    <input type="checkbox" id="${option}" name="functions" value="${option}" ${activeFunctions.includes(option) ? 'checked' : ''} style="width: 16px; height: 16px; accent-color: #ff8a00; cursor: pointer;">
                    ${option}
                </label>
                <button type="button"
                    class="configure-button"
                    data-config-type="${option}"
                    style="align-self: stretch; padding: 6px 8px; background: linear-gradient(90deg, #6a5acd, #836fff); color: #fff; border: none; border-radius: 6px; font-size: 12px; font-weight: bold; cursor: pointer; text-align: center; box-shadow: 0px 2px 6px rgba(0, 0, 0, 0.3);">
                    Configurar
                </button>
            </div>`).join('')}
        </form>
        <footer style="display: flex; justify-content: space-between; margin-top: 20px;">
            <button id="save-functions" style="flex: 1; padding: 10px; margin-right: 8px; background: linear-gradient(90deg, #4caf50, #81c784); color: #fff; border: none; border-radius: 8px; font-size: 14px; font-weight: bold; cursor: pointer; box-shadow: 0px 3px 10px rgba(0, 0, 0, 0.4); transition: background 0.3s, transform 0.3s;">
                Salvar
            </button>
            <button id="close-popup" style="flex: 1; padding: 10px; margin-left: 8px; background: linear-gradient(90deg, #d32f2f, #ff5252); color: #fff; border: none; border-radius: 8px; font-size: 14px; font-weight: bold; cursor: pointer; box-shadow: 0px 3px 10px rgba(0, 0, 0, 0.4); transition: background 0.3s, transform 0.3s;">
                Fechar
            </button>
        </footer>
    </div>`;


    createPopup(content);


    // Event handlers for all configure buttons
    document.querySelectorAll('.configure-button').forEach(button => {
        button.addEventListener('click', (event) => {
            const configType = event.target.getAttribute('data-config-type');
            if (configType === "Edifício Principal") {
                showMainConfig();
            } else if (configType === "Recrutamento") {
                showRecruitmentConfig();
            }
        });
    });




































    // Add hover animations
    document.querySelectorAll('div[style*="transition"]').forEach(card => {
        card.addEventListener('mouseover', () => {
            card.style.transform = 'scale(1.05)';
            card.style.background = '#383838';
        });
        card.addEventListener('mouseout', () => {
            card.style.transform = 'scale(1)';
            card.style.background = '#282828';
        });
    });


    document.querySelectorAll('button').forEach(button => {
        button.addEventListener('mouseover', () => {
            button.style.transform = 'translateY(-2px)';
        });
        button.addEventListener('mouseout', () => {
            button.style.transform = 'translateY(0)';
        });
    });
}



















// Função para exibir o pop-up principal com os dois cards
function showSellPPPopup() {
    console.log('Abrindo o pop-up principal...');
    const content = `
    <div id="sell-pp-popup" style="font-family: Arial, sans-serif; color: #333; max-width: 500px; padding: 20px; border-radius: 12px; background: white; box-shadow: 0 8px 16px rgba(0,0,0,0.2); text-align: center;">
        <h2 style="color: #3498db; margin-bottom: 20px;">💰 Configurar Venda por PPs</h2>

        <!-- Container dos Cards -->
        <div style="display: flex; gap: 15px; justify-content: center; margin-bottom: 20px;">

            <!-- Card Configuração Manual -->
            <div class="sell-pp-card" style="flex: 1; padding: 15px; border: 1px solid #ddd; border-radius: 10px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); cursor: pointer; transition: transform 0.2s ease;" id="manualConfigCard">
                <h3 style="color: #2c3e50;">🛠️ Configuração Manual</h3>
                <p style="font-size: 14px; color: #555;">Defina valores fixos para venda de recursos de forma manual.</p>
            </div>

            <!-- Card Configuração Inteligente -->
            <div class="sell-pp-card" style="flex: 1; padding: 15px; border: 1px solid #ddd; border-radius: 10px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); cursor: pointer; transition: transform 0.2s ease;" id="smartConfigCard">
                <h3 style="color: #2c3e50;">🤖 Configuração Inteligente</h3>
                <p style="font-size: 14px; color: #555;">Venda automática de recursos otimizando preço e demanda.</p>
            </div>
        </div>

        <!-- Botão de Voltar -->
        <button id="back-sell-pp-popup" style="margin-top: 20px; padding: 10px 20px; background: #e74c3c; border: none; color: white; border-radius: 8px; cursor: pointer;">
            Voltar
        </button>
    </div>
    `;

    createPopup(content);

    // Garantir a configuração dos eventos ao exibir o pop-up
    const manualConfigCard = document.getElementById('manualConfigCard');
    const smartConfigCard = document.getElementById('smartConfigCard');
    const backButton = document.getElementById('back-sell-pp-popup');

    // Adicionando logs para depuração
    console.log('Elementos encontrados:', { manualConfigCard, smartConfigCard, backButton });

    // Adicionando eventos de clique apenas se os elementos forem encontrados
    if (manualConfigCard) {
        manualConfigCard.addEventListener('click', showManualConfig);
    } else {
        console.warn('Elemento manualConfigCard não encontrado!');
    }

    if (smartConfigCard) {
        smartConfigCard.addEventListener('click', showSmartConfig);
    } else {
        console.warn('Elemento smartConfigCard não encontrado!');
    }

    // Correção no botão de "Voltar" com log
    if (backButton) {
        backButton.addEventListener('click', () => {
            console.log('Botão voltar clicado.');
            closePopup(); // Fecha o pop-up atual
            showSellPPPopup(); // Reabre o menu principal
        });
    } else {
        console.error('Elemento backButton não encontrado!');
    }
}



// Evento para exibir o pop-up ao clicar no botão de "Configurar"
document.body.addEventListener('click', (event) => {
    if (event.target.getAttribute('data-config-type') === "Vender por pps") {
        console.log('Botão "Configurar" clicado');
        closePopup(); // Garante que não haja pop-ups duplicados
        showSellPPPopup();
    }
});

















function showManualConfig() {
    const content = `
    <div class="popup-overlay" style="
        font-family: 'Poppins', Arial, sans-serif;
        max-width: 770px;
        width: 100%;
        padding: 25px;
        border-radius: 16px;
        background: #f9f9f9;
        box-shadow: 0 12px 30px rgba(0,0,0,0.2);
        border: 1px solid #ddd;
        text-align: center;
        overflow-y: auto;
        box-sizing: border-box;
        animation: fadeIn 0.4s ease-in-out;
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        z-index: 10000;
    ">
        <h2 style="color: #2c3e50; font-size: 24px; margin-bottom: 25px; font-weight: 700;">
            ⚙️ Configuração Avançada de Mercado
        </h2>

        <!-- Abas de Seleção -->
        <div style="display: flex; justify-content: center; gap: 20px; margin-bottom: 30px;">
            <button onclick="toggleSection('sellConfig')" style="flex: 1; padding: 12px; border: none; border-radius: 12px;
                background: linear-gradient(135deg, #FFA500, #FF4500); color: white; cursor: pointer; font-weight: bold;
                box-shadow: 0 6px 15px rgba(0,0,0,0.2); font-size: 18px;">
                💰 Venda
            </button>
            <button onclick="toggleSection('buyConfig')" style="flex: 1; padding: 12px; border: none; border-radius: 12px;
                background: linear-gradient(135deg, #1E90FF, #4169E1); color: white; cursor: pointer; font-weight: bold;
                box-shadow: 0 6px 15px rgba(0,0,0,0.2); font-size: 18px;">
                🛒 Compra
            </button>
        </div>

        <!-- Seção de Venda -->
        <div id="sellConfig" style="display: none;">
            <h3 style="color: #444; font-size: 20px; margin-bottom: 20px;">📊 Configurações de Venda</h3>
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; justify-items: center; margin-top: 15px;">
                ${generateInputField('Madeira', 'woodRate', '🌲')}
                ${generateInputField('Argila', 'clayRate', '🧱')}
                ${generateInputField('Ferro', 'ironRate', '⛏️')}
                ${generateInputField('Reservar Madeira', 'reserveWood', '🌲')}
                ${generateInputField('Reservar Argila', 'reserveClay', '🧱')}
                ${generateInputField('Reservar Ferro', 'reserveIron', '⛏️')}
                ${generateInputField('Venda por vez', 'sellAmount', '📦')}
            </div>
        </div>

        <!-- Seção de Compra -->
        <div id="buyConfig" style="display: block;">
            <h3 style="color: #444; font-size: 20px; margin-bottom: 20px;">🛒 Configurações de Compra</h3>
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; justify-items: center; margin-top: 15px;">
                ${generateInputField('Madeira', 'buyWoodRate', '🌲')}
                ${generateInputField('Argila', 'buyClayRate', '🧱')}
                ${generateInputField('Ferro', 'buyIronRate', '⛏️')}
                ${generateInputField('Compra por vez', 'buyAmount', '📦')}
                ${generateInputField('Limite Armazém', 'storageLimit', '🏢')}
                ${generateInputField('Estoque Mínimo', 'minStock', '📉')}
            </div>
        </div>

        <!-- Botões de Ação -->
        <div style="margin-top: 30px; display: flex; justify-content: space-between; gap: 20px;">
            <button id="sellButton" onclick="activateSell()" style="display: none; flex: 1; padding: 16px; border-radius: 14px; border: none;
                background: linear-gradient(135deg, #FFA500, #FF4500); color: white; font-weight: bold; cursor: pointer;
                box-shadow: 0 6px 15px rgba(0,0,0,0.2); font-size: 20px;">
                ✅ Ativar Venda
            </button>

            <button id="buyButton" onclick="activateBuy()" style="display: block; flex: 1; padding: 16px; border-radius: 14px; border: none;
                background: linear-gradient(135deg, #1E90FF, #4169E1); color: white; font-weight: bold; cursor: pointer;
                box-shadow: 0 6px 15px rgba(0,0,0,0.2); font-size: 20px;">
                🛒 Ativar Compra
            </button>

            <!-- ✅ Atualização: Fechar todos os pop-ups -->
            <button onclick="closeAllPopups()"
    style="flex: 1; padding: 16px; border-radius: 14px; border: none;
    background: linear-gradient(135deg, #DC143C, #B22222); color: white; font-weight: bold; cursor: pointer;
    box-shadow: 0 6px 15px rgba(0, 0, 0, 0.2); font-size: 20px;">
    ❌ Fechar
</button>

        </div>
    </div>
    `;

    createPopup(content);
    setTimeout(restoreState, 100);
}



// Alternador de abas ajustado: botão correto em cada aba
window.toggleSection = function(sectionId) {
    const sections = ['sellConfig', 'buyConfig'];
    const sellButton = document.getElementById('sellButton');
    const buyButton = document.getElementById('buyButton');

    sections.forEach(id => {
        document.getElementById(id).style.display = (id === sectionId) ? 'grid' : 'none';
    });

    // Controle de exibição dos botões
    if (sectionId === 'sellConfig') {
        sellButton.style.display = 'block';
        buyButton.style.display = 'none';
    } else if (sectionId === 'buyConfig') {
        buyButton.style.display = 'block';
        sellButton.style.display = 'none';
    }

    setTimeout(restoreState, 50); // Restaurar estado correto
};


// Função para ativar ações
function activateSell() {
    alert("✅ Venda ativada com sucesso!");
}

function activateBuy() {
    alert("🛒 Compra ativada com sucesso!");
}

// Gerador de campos de entrada
function generateInputField(label, id, icon) {
    return `
    <div style="background: #fff; padding: 12px; border-radius: 10px;
        width: 85%; box-shadow: 0 4px 12px rgba(0,0,0,0.12); cursor: pointer;">
        <label for="${id}" style="font-weight: bold; font-size: 14px; margin-bottom: 5px;">
            ${icon} ${label}
        </label>
        <input type="number" id="${id}"
            style="width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 8px;
            font-size: 14px; box-sizing: border-box;"/>
    </div>
    `;
}





// Função global para fechar QUALQUER pop-up corretamente, sem bugs
window.closeAllPopups = function () {
    const popups = document.querySelectorAll('.popup-overlay, .popup_box, #custom-popup');
    if (popups.length > 0) {
        popups.forEach(popup => {
            popup.style.opacity = '0';
            setTimeout(() => popup.remove(), 300); // Animação de fade-out antes de remover
        });
        console.log(`✅ ${popups.length} pop-up(s) fechado(s) com sucesso!`);
    } else {
        console.warn('⚠️ Nenhum pop-up encontrado para fechar.');
    }
};






// Atualiza o texto e salva o estado de venda
window.activateSell = function () {
    const sellButton = document.getElementById('sellButton');
    if (!sellButton) {
        console.error("❌ Botão de venda não encontrado!");
        return;
    }

    const isActive = sellButton.dataset.active === 'true';
    sellButton.dataset.active = (!isActive).toString();
    localStorage.setItem('sellActive', (!isActive).toString());
    console.log('Venda:', isActive ? 'Desativada' : 'Ativada');
    updateButtonState(sellButton, !isActive, "Venda");
};

// Atualiza o texto e salva o estado de compra
window.activateBuy = function () {
    const buyButton = document.getElementById('buyButton');
    if (!buyButton) {
        console.error("❌ Botão de compra não encontrado!");
        return;
    }

    const isActive = buyButton.dataset.active === 'true';
    buyButton.dataset.active = (!isActive).toString();
    localStorage.setItem('buyActive', (!isActive).toString());
    console.log('Compra:', isActive ? 'Desativada' : 'Ativada');
    updateButtonState(buyButton, !isActive, "Compra");
};

// Atualiza o estilo e o texto do botão com base no estado
function updateButtonState(button, isActive, action) {
    console.log(`Atualizando estado do botão: ${action} - Estado: ${isActive}`);

    button.innerText = isActive
        ? `❌ Desativar ${action}`
        : `✅ Ativar ${action}`;

    button.style.background = isActive
        ? "linear-gradient(135deg, #DC143C, #B22222)"
        : (action === "Venda" ? "linear-gradient(135deg, #FFA500, #FF4500)" : "linear-gradient(135deg, #1E90FF, #4169E1)");
}

/// Adicionando salvamento automático para os campos de input
window.addEventListener('input', function (event) {
    if (event.target.tagName === 'INPUT') {
        const inputId = event.target.id;
        const inputValue = event.target.value;
        localStorage.setItem(inputId, inputValue);
        console.log(`💾 Valor salvo: ${inputId} = ${inputValue}`);
    }
});

// Função aprimorada para restaurar o estado dos inputs
function restoreState() {
    console.log("⏳ Restaurando estados dos botões e inputs...");

    setTimeout(() => {
        const sellButton = document.getElementById('sellButton');
        const buyButton = document.getElementById('buyButton');

        if (sellButton) {
            const isSellActive = localStorage.getItem('sellActive') === 'true';
            sellButton.dataset.active = isSellActive.toString();
            updateButtonState(sellButton, isSellActive, "Venda");
        }

        if (buyButton) {
            const isBuyActive = localStorage.getItem('buyActive') === 'true';
            buyButton.dataset.active = isBuyActive.toString();
            updateButtonState(buyButton, isBuyActive, "Compra");
        }

        // Restaurando valores dos inputs salvos
        document.querySelectorAll('input[type="number"]').forEach(input => {
            const savedValue = localStorage.getItem(input.id);
            if (savedValue !== null) {
                input.value = savedValue;
                console.log(`📦 Valor restaurado: ${input.id} = ${savedValue}`);
            }
        });
    }, 50); // Pequeno delay para garantir que o DOM esteja pronto
}

// Garantir a restauração completa ao carregar a página
window.addEventListener('load', () => {
    console.log("🚀 Página carregada! Restaurando estados...");
    setTimeout(restoreState, 100);
});















// ✅ Garantir que o script rode apenas na tela de mercado e na aba de troca premium
(function () {
    const urlAtual = window.location.href;
    const regexMercadoPremium = /screen=market&mode=exchange/;

    if (!regexMercadoPremium.test(urlAtual)) {
        console.warn("⚠️ Script bloqueado! Você não está na tela de troca premium.");
        return; // ✅ Bloqueia a execução caso a URL não corresponda
    }

    console.log("✅ Script de venda premium ativado corretamente!");

// ✅ Função genérica para capturar valores do DOM ou LocalStorage
function capturarValorDoElemento(seletor, storageKey) {
    const elemento = document.querySelector(seletor);
    if (elemento) {
        const valor = elemento.tagName === 'INPUT'
            ? parseInt(elemento.value.trim().replace(/\D/g, ''), 10) || 0
            : parseInt(elemento.textContent.trim().replace(/\D/g, ''), 10) || 0;
        localStorage.setItem(storageKey, valor);
        return valor;
    }
    return parseInt(localStorage.getItem(storageKey), 10) || 0;
}

// ✅ Função para capturar a capacidade máxima de transporte
function obterCapacidadeTransporte() {
    const capacidade = capturarValorDoElemento('#market_merchant_max_transport', 'capacidadeTransporte');
    console.log(`🚚 Capacidade Máxima de Transporte: ${capacidade}`);
    return capacidade;
}

// ✅ Função para capturar o valor de venda por vez
function obterValorVendaPorVez() {
    const vendaPorVez = capturarValorDoElemento('#sellAmountInput', 'sellAmount');
    console.log(`📦 Venda Máxima por Vez: ${vendaPorVez}`);
    return vendaPorVez;
}

// ✅ Função para capturar o estoque e a capacidade premium
function obterEstoqueECapacidadePremium() {
    const estoque = {
        madeira: capturarValorDoElemento('#premium_exchange_stock_wood', 'stockWood'),
        argila: capturarValorDoElemento('#premium_exchange_stock_stone', 'stockClay'),
        ferro: capturarValorDoElemento('#premium_exchange_stock_iron', 'stockIron')
    };
    const capacidade = {
        madeira: capturarValorDoElemento('#premium_exchange_capacity_wood', 'capacityWood'),
        argila: capturarValorDoElemento('#premium_exchange_capacity_stone', 'capacityClay'),
        ferro: capturarValorDoElemento('#premium_exchange_capacity_iron', 'capacityIron')
    };

    console.log("📦 Estoque Premium Atual:", estoque);
    console.log("🗄️ Capacidade Premium Atual:", capacidade);
    return { estoque, capacidade };
}

// ✅ Função para capturar taxas premium e taxas de venda
function obterTaxas() {
    const taxasPremium = {
        madeira: capturarValorDoElemento('#premium_exchange_rate_wood > div:nth-child(1)', 'premiumWood'),
        argila: capturarValorDoElemento('#premium_exchange_rate_stone > div:nth-child(1)', 'premiumClay'),
        ferro: capturarValorDoElemento('#premium_exchange_rate_iron > div:nth-child(1)', 'premiumIron')
    };

    const taxasVenda = {
        madeira: capturarValorDoElemento('#sell_rate_wood', 'woodRate'),
        argila: capturarValorDoElemento('#sell_rate_stone', 'clayRate'),
        ferro: capturarValorDoElemento('#sell_rate_iron', 'ironRate')
    };

    console.log("💡 Taxas Premium Capturadas:", taxasPremium);
    console.log("💱 Taxas de Venda Capturadas:", taxasVenda);

    return { taxasPremium, taxasVenda };
}

// ✅ Função para capturar recursos disponíveis após considerar as reservas
function calcularRecursosDisponiveis() {
    const inventario = {
        madeira: capturarValorDoElemento('#wood', 'woodStock'),
        argila: capturarValorDoElemento('#stone', 'clayStock'),
        ferro: capturarValorDoElemento('#iron', 'ironStock')
    };
    const reservas = {
        madeira: parseInt(localStorage.getItem('reserveWood'), 10) || 0,
        argila: parseInt(localStorage.getItem('reserveClay'), 10) || 0,
        ferro: parseInt(localStorage.getItem('reserveIron'), 10) || 0
    };

    const recursosDisponiveis = {
        madeira: Math.max(inventario.madeira - reservas.madeira, 0),
        argila: Math.max(inventario.argila - reservas.argila, 0),
        ferro: Math.max(inventario.ferro - reservas.ferro, 0)
    };

    console.log("📊 Recursos Disponíveis após Reservas:", recursosDisponiveis);
    return recursosDisponiveis;
}

// ✅ Função para calcular o recurso mais vantajoso para venda considerando taxa premium
// ✅ Função para calcular o recurso mais vantajoso para venda considerando taxa premium
function calcularRecursosParaVendaMelhor() {
    const recursosDisponiveis = calcularRecursosDisponiveis();
    const capacidadeTransporte = obterCapacidadeTransporte();
    const valorVendaPorVez = obterValorVendaPorVez();
    const { estoque, capacidade } = obterEstoqueECapacidadePremium();
    const { taxasPremium, taxasVenda } = obterTaxas();

    const diferencaCapacidadeEstoque = {
        madeira: capacidade.madeira - estoque.madeira,
        argila: capacidade.argila - estoque.argila,
        ferro: capacidade.ferro - estoque.ferro
    };

    console.log("📊 Diferença Capacidade - Estoque (Capacidade Restante):", diferencaCapacidadeEstoque);

    let melhorRecurso = null;
    let menorTaxa = Infinity;
    let quantidadeFinal = 0;

    Object.keys(taxasPremium).forEach(recurso => {
        const taxaPremium = taxasPremium[recurso];

        // ✅ Agora verificando se o jogador tem pelo menos 1x taxa para iniciar a venda
        if (recursosDisponiveis[recurso] < taxaPremium) {
            console.warn(`❌ Recursos insuficientes para cobrir a taxa premium de ${recurso}`);
            return;
        }

        // ✅ Calcular o maior múltiplo possível de taxa premium sem ultrapassar limites
        const quantidadeMaximaPossivel = Math.floor(
            Math.min(
                recursosDisponiveis[recurso],
                capacidadeTransporte,
                diferencaCapacidadeEstoque[recurso],
                valorVendaPorVez
            ) / taxaPremium
        ) * taxaPremium;

        // ✅ Garantindo que o mínimo seja ao menos 1x o valor da taxa
        if (quantidadeMaximaPossivel >= taxaPremium && taxaPremium < menorTaxa) {
            melhorRecurso = recurso;
            menorTaxa = taxaPremium;
            quantidadeFinal = quantidadeMaximaPossivel;
        }
    });

    if (!melhorRecurso || quantidadeFinal < menorTaxa) {
        console.warn("⚠️ Nenhum recurso atende às condições mínimas para venda.");
        return {};
    }

    console.log(`🏷️ Melhor Recurso Selecionado: ${melhorRecurso}`);
    console.log(`📦 Quantidade Calculada Respeitando a Taxa Premium: ${quantidadeFinal}`);
    return { [melhorRecurso]: quantidadeFinal };
}

// ✅ Função para validar e executar a venda automatizada apenas se a venda estiver ativada
function validarVendaAutomatizadaMelhorTaxa() {
    console.log("🔍 Testando Venda com Menor Taxa Premium (Atualizado)...");

    // ✅ Verificação centralizada: venda deve estar ativada no localStorage
    if (localStorage.getItem('sellActive') !== 'true') {
        console.warn("⚠️ Venda automatizada não está ativada. Encerrando execução.");
        return;
    }

    console.log("✅ Venda Ativada! Preenchendo o input do recurso com menor taxa premium...");
    preencherInputMelhorVenda();
}

// ✅ Função para preencher os inputs corretamente com validação e taxa premium
// ✅ Função para preencher os inputs corretamente e clicar automaticamente nos botões
function preencherInputMelhorVenda() {
    const recursosParaVenda = calcularRecursosParaVendaMelhor();
    const inputs = {
        madeira: document.querySelector('input[name="sell_wood"]'),
        argila: document.querySelector('input[name="sell_stone"]'),
        ferro: document.querySelector('input[name="sell_iron"]')
    };

    let vendaValida = false;

    // ✅ Limpar inputs antes de preencher
    Object.values(inputs).forEach(input => (input.value = ''));

    // ✅ Preencher inputs se a quantidade for válida
    Object.entries(recursosParaVenda).forEach(([recurso, quantidade]) => {
        if (inputs[recurso] && quantidade > 0) {
            inputs[recurso].value = quantidade;
            vendaValida = true;
            console.log(`🎯 Input preenchido para ${recurso}: ${quantidade}`);
        } else {
            console.warn(`⚠️ Nenhum input preenchido para ${recurso}`);
        }
    });

    // ✅ Se os critérios forem atendidos, clicar no botão "Calcular melhor oferta"
    if (vendaValida) {
        const botaoCalcularMelhorOferta = document.querySelector('input.btn-premium-exchange-buy');
        if (botaoCalcularMelhorOferta) {
            botaoCalcularMelhorOferta.click();
            console.log('✅ Botão "Calcular melhor oferta" clicado automaticamente!');

            // ✅ Aguardar a interface processar antes de clicar em "Confirmar"
            setTimeout(() => {
                const botaoConfirmar = document.querySelector('button.btn-confirm-yes');
                if (botaoConfirmar) {
                    botaoConfirmar.click();
                    console.log('✅ Botão "Confirmar" clicado automaticamente!');
                } else {
                    console.error('❌ Botão "Confirmar" não encontrado!');
                }
            }, 1500); // ✅ Delay de segurança para garantir que a interface carregue
        } else {
            console.error('❌ Botão "Calcular melhor oferta" não encontrado!');
        }
    } else {
        console.warn("⚠️ Critérios não atendidos, botões não clicados.");
    }
}

// ✅ Teste Completo: Executar apenas se a venda estiver ativada e clicar automaticamente nos botões
console.log("🔍 Testando Venda Completa com Clique Automático...");
validarVendaAutomatizadaMelhorTaxa();

})();















// Função para exibir o pop-up de configuração inteligente
function showSmartConfig() {
    const content = `
    <div style="font-family: Arial, sans-serif; color: #333; max-width: 400px; padding: 20px; border-radius: 12px; background: white; box-shadow: 0 8px 16px rgba(0,0,0,0.2); text-align: center;">
        <h2 style="color: #8e44ad;">🤖 Configuração Inteligente</h2>
        <p>Este modo ajusta automaticamente os preços baseando-se na demanda do mercado.</p>
        <label>Ativar Venda Automática:
            <input type="checkbox" id="enableSmartSell">
        </label>
        <button onclick="saveSmartConfig()" style="margin-top: 20px; padding: 10px 20px; background: #27ae60; color: white; border: none; border-radius: 8px; cursor: pointer;">Salvar</button>
        <button onclick="showSellPPPopup()" style="margin-top: 10px; padding: 10px 20px; background: #e74c3c; color: white; border: none; border-radius: 8px; cursor: pointer;">Voltar</button>
    </div>
    `;
    createPopup(content);
}

// Função para salvar a configuração manual
function saveManualConfig() {
    const minPrice = parseInt(document.getElementById('manualMinPrice').value) || 0;
    const resourceAmount = parseInt(document.getElementById('manualResourceAmount').value) || 0;

    recruitmentConfig.sellPP = {
        minPrice,
        resourceAmount
    };

    saveRecruitmentConfig();
    alert('✅ Configuração Manual salva com sucesso!');
    closePopup();
}

// Função para salvar a configuração inteligente
function saveSmartConfig() {
    const enableSmartSell = document.getElementById('enableSmartSell').checked;
    recruitmentConfig.sellPP.smartSellEnabled = enableSmartSell;

    saveRecruitmentConfig();
    alert('✅ Configuração Inteligente salva com sucesso!');
    closePopup();
}












































// Função para exibir o pop-up de configuração de recrutamento
function showRecruitmentConfig() {
    const content = `
    <div style="font-family: Arial, sans-serif; color: #333; max-width: 450px; margin: 0 auto; padding: 10px; background-color: #f9f9f9; border-radius: 10px; box-shadow: 0px 4px 8px rgba(0, 0, 0, 0.2); max-height: 85vh; overflow-y: auto;">
        <h2 style="margin-top: 0; color: #007bff; font-size: 18px; text-align: center; border-bottom: 2px solid #ddd; padding-bottom: 5px;">🎯 Configuração de Recrutamento</h2>
        <div id="success-message" style="display: none; text-align: center; margin-bottom: 10px; padding: 5px; background-color: #d4edda; color: #155724; border: 1px solid #c3e6cb; border-radius: 5px; font-size: 14px;">
            Configurações salvas com sucesso!
        </div>
        <form id="recruitment-form" style="margin-top: 10px;">
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 8px;">
                ${createRecruitmentRows([
                    { id: 'spear', name: 'Lanceiros', icon: '⚜️' },
                    { id: 'sword', name: 'Espadachins', icon: '⚔️' },
                    { id: 'axe', name: 'Machados', icon: '🪓' },
                    { id: 'archer', name: 'Arqueiros', icon: '🏹' },
                    { id: 'scout', name: 'Explorador', icon: '🕵️' },
                    { id: 'light', name: 'Cavalaria Leve', icon: '🐎' },
                    { id: 'marcher', name: 'Arqueiros a Cavalo', icon: '🏇' },
                    { id: 'heavy', name: 'Cavalaria Pesada', icon: '🐴' },
                    { id: 'ram', name: 'Arietes', icon: '🐏' },
                    { id: 'catapult', name: 'Catapultas', icon: '🎯' }
                ])}
            </div>


            <div style="display: flex; justify-content: center; gap: 10px; margin-top: 15px;">
                <button id="save-recruitment-config" style="padding: 6px 12px; background-color: #28a745; color: white; border: none; border-radius: 5px; font-size: 12px; cursor: pointer;">
                    Salvar
                </button>
                <button id="close-popup" style="padding: 6px 12px; background-color: #dc3545; color: white; border: none; border-radius: 5px; font-size: 12px; cursor: pointer;">
                    Fechar
                </button>
            </div>
        </form>
    </div>`;
    createPopup(content);


    // Adicionar evento de salvar as configurações
    document.getElementById('save-recruitment-config').addEventListener('click', saveRecruitmentSettings);


    // Adicionar evento para fechar o pop-up
    document.getElementById('close-popup').addEventListener('click', closePopup);
}






















































/**
 * Retorna o nome traduzido de um edifício com base no ID do edifício e no idioma do navegador.
 *
 * @param {string} buildingId - O identificador único do edifício (exemplo: "Main", "Barracks").
 * @returns {string} - O nome do edifício no idioma do navegador, ou no idioma padrão (inglês),
 * caso a tradução no idioma do navegador não esteja disponível.
 */


function getBuildingName(buildingId) {
    const translations = {
        Main: { en: "Main Building", pt: "Edifício Principal" },
        Statue: { en: "Statue", pt: "Estátua" },
        Wood: { en: "Woodcutter", pt: "Bosque" },
        Clay: { en: "Clay Pit", pt: "Poço de Argila" },
        Iron: { en: "Iron Mine", pt: "Mina de Ferro" },
        Farm: { en: "Farm", pt: "Fazenda" },
        Storage: { en: "Storage", pt: "Armazém" },
        Hide: { en: "Hideout", pt: "Esconderijo" },
        Barracks: { en: "Barracks", pt: "Quartel" },
        Stable: { en: "Stable", pt: "Estábulo" },
        Workshop: { en: "Workshop", pt: "Oficina" },
        Watchtower: { en: "Watchtower", pt: "Torre de Vigia" },
        Academy: { en: "Academy", pt: "Academia" },
        Smith: { en: "Smithy", pt: "Ferreiro" },
        Market: { en: "Market", pt: "Mercado" },
        Wall: { en: "Wall", pt: "Muralha" },
        ConstructionOrders: { en: "Construction Orders", pt: "Ordens de Construção" }
    };


    const lang = navigator.language.slice(0, 2); // Obtém o idioma do navegador (ex: "pt" ou "en")
    return translations[buildingId]?.[lang] || translations[buildingId]?.en || buildingId;
}


/**
 * Exibe um popup centralizado na tela com configurações para ajustar os níveis dos edifícios no jogo.
 * O popup inclui um formulário dinâmico, gerado pela função `generateBuildingCards`, onde o usuário
 * pode definir os níveis desejados para cada edifício, além de dois botões para salvar ou fechar o popup.
 */


function showMainConfig() {
    const content = `
    <div style="font-family: Arial, sans-serif; width: 600px; margin: auto; padding: 10px; background: #ffffff; border: 1px solid #ccc; border-radius: 8px; box-shadow: 2px 2px 8px rgba(0, 0, 0, 0.1); position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);">
        <h2 style="margin-top: 0; color: #2c3e50; font-size: 18px; text-align: center; border-bottom: 2px solid #3498db; padding-bottom: 5px;">
            🏗️ Configuração de Construção Inteligente
        </h2>
        <p style="text-align: center; font-size: 12px; color: #34495e; margin: 0 0 10px;">
            Configure os níveis desejados para cada edifício de forma rápida e automatize a fila!
        </p>
        <form id="building-config-form" style="display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px;">
            ${generateBuildingCards()}
        </form>
        <div style="text-align: center; margin-top: 10px;">
            <button id="save-building-config" style="padding: 8px 16px; background: #2ecc71; color: white; border: none; border-radius: 5px; font-size: 14px; cursor: pointer; box-shadow: 0px 2px 4px rgba(0, 0, 0, 0.1);">
                Salvar Configurações
            </button>
            <button id="close-popup" style="padding: 8px 16px; background: #e74c3c; color: white; border: none; border-radius: 5px; font-size: 14px; cursor: pointer; box-shadow: 0px 2px 4px rgba(0, 0, 0, 0.1); margin-left: 8px;">
                Fechar
            </button>
        </div>
    </div>`;
    createPopup(content);


    // Evento para salvar as configurações
    document.getElementById('save-building-config').addEventListener('click', saveBuildingConfig);


    // Evento para fechar o pop-up
    document.getElementById('close-popup').addEventListener('click', closePopup);
}






// Gera os cards para cada edifício, incluindo o novo card "Adicionar Ordem por Texto"
function generateBuildingCards() {
    const buildings = [
        { name: "Ordens de Construção", id: "constructionOrders", icon: "📜" },
        { name: "Ordem por Texto", id: "addOrderByText", icon: "📓" },
        { name: "Configurar Execução", id: "executionConfig", icon: "⚙️" }, // Novo card
    ];


    return buildings.map(building => `
        <div style="border: 1px solid #bdc3c7; border-radius: 5px; padding: 5px; background: white; box-shadow: 0px 2px 4px rgba(0, 0, 0, 0.1); display: flex; flex-direction: column; align-items: center; text-align: center; font-size: 10px;">
            <div style="font-size: 18px; margin-bottom: 4px;">${building.icon}</div>
            <h4 style="color: #34495e; font-size: 12px; margin-bottom: 4px;">${building.name}</h4>
            ${building.id === "constructionOrders" ? `
            <button id="btn-construction-orders" style="padding: 4px 10px; background: #3498db; color: white; border: none; border-radius: 5px; font-size: 10px; cursor: pointer; box-shadow: 0px 2px 4px rgba(0, 0, 0, 0.1);">
                Ver Configurações
            </button>
            ` : building.id === "addOrderByText" ? `
            <button id="btn-add-order-by-text" style="padding: 4px 10px; background: #3498db; color: white; border: none; border-radius: 5px; font-size: 10px; cursor: pointer; box-shadow: 0px 2px 4px rgba(0, 0, 0, 0.1);">
                Adicionar por Texto
            </button>
            ` : building.id === "executionConfig" ? `
            <button id="btn-execution-config" style="padding: 4px 10px; background: #3498db; color: white; border: none; border-radius: 5px; font-size: 10px; cursor: pointer; box-shadow: 0px 2px 4px rgba(0, 0, 0, 0.1);">
                Configurar Execução
            </button>
            ` : ''}
        </div>
    `).join('');
}




// Manter os eventos existentes para "Ver Configurações"
document.body.addEventListener('click', (event) => {
    if (event.target.id === 'btn-construction-orders') {
        openConstructionOrdersPopup();
    }
});


// Evento para abrir o popup para adicionar ordem por texto
document.body.addEventListener('click', (event) => {
    if (event.target.id === 'btn-add-order-by-text') {
        openAddOrderByTextPopup();
    }
});
































function openExecutionConfigPopup() {
    // Carrega as configurações existentes ou usa valores padrão
    const currentConfig = recruitmentConfig.execution || {
        mode: "followOrder",
        advancedResourceManagement: false,
        optimizeTime: false,
        premiumBudget: 0,
        usePremiumForResources: false,
        activateRewards: false, // Nova configuração padrão
    };


    const content = `
    <div style="font-family: 'Arial', sans-serif; width: 600px; background: #f4f4f4; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2); position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #333;">
        <header style="background: #3498db; padding: 16px; text-align: center; font-size: 18px; font-weight: bold; color: white; border-bottom: 1px solid #2980b9;">
            ⚙️ Configurações Avançadas de Execução
        </header>
        <div style="padding: 20px; display: flex; flex-direction: column; gap: 16px; max-height: 80vh; overflow-y: auto;">
            <!-- Modo de Construção -->
            <section style="padding: 10px; border: 1px solid #ccc; border-radius: 8px; background: white;">
                <h3 style="font-size: 14px; margin-bottom: 10px;">🔧 Modo de Construção</h3>
                <label style="display: flex; align-items: center; gap: 10px; margin-bottom: 5px; font-size: 14px;">
                    <input type="radio" name="build-mode" value="followOrder" ${currentConfig.mode === "followOrder" ? "checked" : ""}>
                    Seguir a Ordem
                </label>
                <label style="display: flex; align-items: center; gap: 10px; font-size: 14px;">
                    <input type="radio" name="build-mode" value="opportunistic" ${currentConfig.mode === "opportunistic" ? "checked" : ""}>
                    Construção Oportuna
                </label>
            </section>


            <!-- Otimização de Tempo -->
            <section style="padding: 10px; border: 1px solid #ccc; border-radius: 8px; background: white;">
                <h3 style="font-size: 14px; margin-bottom: 10px;">⏱️ Otimização de Tempo</h3>
                <label style="display: flex; align-items: center; gap: 10px; font-size: 14px;">
                    <input type="checkbox" id="optimize-time" ${currentConfig.optimizeTime ? "checked" : ""}>
                    Reduzir automaticamente o tempo crítico de construção
                </label>
            </section>


            <!-- Controle de Pontos Premium -->
            <section style="padding: 10px; border: 1px solid #ccc; border-radius: 8px; background: white;">
                <h3 style="font-size: 14px; margin-bottom: 10px;">💎 Reduzir Custos de Recursos</h3>
                <label style="display: flex; align-items: center; gap: 10px; font-size: 14px;">
                    <input type="checkbox" id="use-premium-for-resources" ${currentConfig.usePremiumForResources ? "checked" : ""}>
                    Usar Pontos Premium para reduzir custos de recursos
                </label>
                <label style="display: flex; flex-direction: column; gap: 5px; font-size: 14px; margin-top: 10px;">
                    <span>Orçamento Máximo de Pontos Premium:</span>
                    <input type="number" id="premium-budget" min="0" value="${currentConfig.premiumBudget}" style="padding: 5px; font-size: 14px; border: 1px solid #ccc; border-radius: 4px; width: 100%;">
                </label>
            </section>


            <!-- Gestão Avançada de Recursos -->
            <section style="padding: 10px; border: 1px solid #ccc; border-radius: 8px; background: white;">
                <h3 style="font-size: 14px; margin-bottom: 10px;">📊 Gestão de Recursos</h3>
                <label style="display: flex; align-items: center; gap: 10px; font-size: 14px;">
                    <input type="checkbox" id="advanced-resource-management" ${currentConfig.advancedResourceManagement ? "checked" : ""}>
                    Monitorar recursos e fazer construções otimizadas
                </label>
            </section>


            <!-- Ativar Recompensas -->
            <section style="padding: 10px; border: 1px solid #ccc; border-radius: 8px; background: white;">
                <h3 style="font-size: 14px; margin-bottom: 10px;">🏆 Recompensas</h3>
                <label style="display: flex; align-items: center; gap: 10px; font-size: 14px;">
                    <input type="checkbox" id="activate-rewards" ${currentConfig.activateRewards ? "checked" : ""}>
                    Ativar Recompensas Automáticas
                </label>
            </section>
        </div>
        <footer style="background: #ecf0f1; padding: 16px; text-align: center; border-top: 1px solid #ccc;">
            <button id="save-execution-config" style="padding: 10px 20px; background: #27ae60; color: white; border: none; border-radius: 6px; font-size: 14px; cursor: pointer;">
                Salvar Configurações
            </button>
            <button id="close-popup-execution" style="padding: 10px 20px; background: #e74c3c; color: white; border: none; border-radius: 6px; font-size: 14px; margin-left: 10px; cursor: pointer;">
                Fechar
            </button>
        </footer>
    </div>`;


    createPopup(content);


    // Eventos para salvar e fechar
    document.getElementById('save-execution-config').addEventListener('click', saveExecutionConfig);
    document.getElementById('close-popup-execution').addEventListener('click', closePopup);
}




 function saveExecutionConfig() {
    const mode = document.querySelector('input[name="build-mode"]:checked').value;
    const optimizeTime = document.getElementById('optimize-time').checked;
    const usePremiumForResources = document.getElementById('use-premium-for-resources').checked;
    const premiumBudget = parseInt(document.getElementById('premium-budget').value, 10) || 0;
    const advancedResourceManagement = document.getElementById('advanced-resource-management').checked;
    const activateRewards = document.getElementById('activate-rewards').checked;


    recruitmentConfig.execution = {
        mode,
        optimizeTime,
        usePremiumForResources,
        premiumBudget,
        advancedResourceManagement,
        activateRewards // Salva o estado do novo checkbox
    };


    localStorage.setItem('recruitmentConfig', JSON.stringify(recruitmentConfig));
    alert("Configurações salvas com sucesso!");
    closePopup();
}


















































// Código do popup para "Adicionar Ordem por Texto" permanece o mesmo
function openAddOrderByTextPopup() {
    const content = `
    <div style="font-family: 'Arial', sans-serif; width: 600px; background: #f4f4f4; border-radius: 12px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2); position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); overflow: hidden;">
        <header style="background: linear-gradient(135deg, #6a11cb, #2575fc); color: white; padding: 16px; text-align: center; font-size: 18px; font-weight: bold; letter-spacing: 1px;">
            📓 Adicionar Ordem por Texto
        </header>
        <div style="padding: 20px; display: flex; flex-direction: column; gap: 16px;">
            <!-- Texto de explicação -->
            <p style="margin: 0; font-size: 14px; color: #555; text-align: center;">
                Escolha um <strong>perfil estratégico</strong> abaixo para preencher automaticamente ou personalize suas ordens de construção.
            </p>


            <!-- Opções de perfis -->
            <div style="display: flex; justify-content: space-between; gap: 10px;">
                ${createProfileCard('sprinter', 'Sprinter', '🏃', 'Foco em velocidade e crescimento rápido.')}
                ${createProfileCard('attack', 'Ataque', '⚔️', 'Ideal para estratégias agressivas.')}
                ${createProfileCard('defense', 'Defesa', '🛡️', 'Fortaleça sua vila contra invasores.')}
                ${createProfileCard('resources', 'Recursos', '💰', 'Aumente sua produção e capacidade.')}
            </div>


            <!-- Caixa de texto para ordens -->
          <textarea id="order-textarea"
    placeholder="Digite ou selecione um perfil acima para preencher automaticamente. Exemplo:\nMain,10\nBarracks,5"
    style="
        display: block;
        width: calc(100% - 20px); /* Reduzido um pouco menos para alinhar perfeitamente com os cards */
        height: 120px;
        padding: 10px;
        border: 1px solid #ccc;
        border-radius: 8px;
        font-size: 14px;
        color: #333;
        background: #fff;
        box-shadow: inset 0 2px 5px rgba(0, 0, 0, 0.1);
        resize: none;
        margin: 0 auto;
    ">
</textarea>



            <!-- Botões de ação -->
            <div style="display: flex; justify-content: space-between; gap: 10px;">
                <button id="save-order-text" style="flex: 1; padding: 10px; background: #28a745; color: white; border: none; border-radius: 8px; font-size: 14px; font-weight: bold; cursor: pointer; box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);">
                    Salvar
                </button>
                <button id="close-popup-text" style="flex: 1; padding: 10px; background: #e74c3c; color: white; border: none; border-radius: 8px; font-size: 14px; font-weight: bold; cursor: pointer; box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);">
                    Fechar
                </button>
            </div>
        </div>
    </div>`;
    createPopup(content);


    // Eventos de clique para os perfis
    const cards = document.querySelectorAll('.profile-card');
    cards.forEach(card => {
        card.addEventListener('click', () => {
            const profile = card.getAttribute('data-profile');
            const textarea = document.getElementById('order-textarea');
            textarea.value = getPresetOrder(profile);


            // Destacar o card selecionado
            cards.forEach(c => c.classList.remove('selected-card'));
            card.classList.add('selected-card');
        });
    });


    // Eventos para os botões
    document.getElementById('save-order-text').addEventListener('click', saveOrderByText);
    document.getElementById('close-popup-text').addEventListener('click', closePopup);
}


// Função para criar um card de perfil
function createProfileCard(profile, title, icon, description) {
    return `
    <div class="profile-card" data-profile="${profile}" style="flex: 1; padding: 12px; background: white; border: 2px solid #ddd; border-radius: 8px; text-align: center; cursor: pointer; transition: all 0.3s ease; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);">
        <div style="font-size: 24px; margin-bottom: 8px;">${icon}</div>
        <h3 style="font-size: 16px; margin: 0; color: #333;">${title}</h3>
        <p style="font-size: 12px; color: #555; margin-top: 4px;">${description}</p>
    </div>`;
}


// Estilo para card selecionado
const style = document.createElement('style');
style.textContent = `
    .profile-card:hover {
        background: #f7f7f7;
        border-color: #3498db;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
    }
    .profile-card.selected-card {
        background: #3498db;
        color: white;
        border-color: #2980b9;
    }
`;
document.head.appendChild(style);


// Retorna ordens pré-definidas com base no perfil escolhido
// Retorna ordens pré-definidas com base no perfil escolhido
function getPresetOrder(profile) {
    const orders = {
        sprinter: `Main 1
Statue 1
Storage 1
Pedra 1
Bosque 1
Mina de ferro 1
Fazenda 1
Main 2
Storage 2
Bosque 2
Pedra 2
Mina de ferro 2
Bosque 3
Pedra 3
Main 3
Fazenda 2
Bosque 4
Pedra 4
Storage 3
Mina de ferro 3
Main 4
Quartel 1
Bosque 5
Pedra 5
Mina de ferro 4
Storage 4
Main 5
Fazenda 3
Bosque 6
Pedra 6
Mina de ferro 5
Storage 5
Quartel 2
Bosque 7
Pedra 7
Main 6
Bosque 8
Fazenda 4
Pedra 8
Mina de ferro 6
Storage 6
Quartel 3
Bosque 9
Main 7
Pedra 9
Fazenda 5
Mina de ferro 7
Storage 7
Main 8
Bosque 10
Pedra 10
Mina de ferro 8
Storage 8
Quartel 4
Fazenda 6
Main 9
Bosque 11
Pedra 11
Mina de ferro 9
Storage 9
Quartel 5
Fazenda 7
Main 10
Bosque 12
Pedra 12
Mina de ferro 10
Storage 10
Quartel 6
Fazenda 8
Bosque 13
Main 11
Pedra 13
Mina de ferro 11
Storage 11
Ferreiro 1
Bosque 14
Quartel 7
Pedra 14
Mina de ferro 12
Storage 12
Main 12
Fazenda 9
Bosque 15
Pedra 15
Mina de ferro 13
Storage 13
Ferreiro 2
Bosque 16
Main 13
Pedra 16
Mina de ferro 14
Storage 14
Quartel 8
Bosque 17
Fazenda 10
Pedra 17
Mina de ferro 15
Storage 15
Main 14
Bosque 18
Pedra 18
Mina de ferro 16
Storage 16
Ferreiro 3
Bosque 19
Main 15
Pedra 19
Mina de ferro 17
Storage 17
Fazenda 11
Bosque 20
Pedra 20
Mina de ferro 18
Storage 18
Quartel 9
Bosque 21
Main 16
Pedra 21
Mina de ferro 19
Storage 19
Fazenda 12
Bosque 22
Pedra 22
Mina de ferro 20
Storage 20
Quartel 10
Main 17
Bosque 23
Pedra 23
Mina de ferro 21
Storage 21
Fazenda 13
Bosque 24
Pedra 24
Mina de ferro 22
Storage 22
Ferreiro 5
Main 18
Bosque 25
Pedra 25
Mina de ferro 23
Storage 23
Fazenda 14
Bosque 26
Pedra 26
Mina de ferro 24
Storage 24
Main 19
Bosque 27
Pedra 27
Mina de ferro 25
Storage 25
Fazenda 15
Bosque 28
Pedra 28
Mina de ferro 26
Storage 26
Main 20
Bosque 29
Pedra 29
Mina de ferro 27
Storage 27
Fazenda 16
Bosque 30
Pedra 30
Mina de ferro 28
Storage 28
Academia 1
Quartel 15
Ferreiro 10
Oficina 5
Quartel 20
Storage 30
Fazenda 30`
,
       attack: `Main 1
Statue 1
Pedra 1
Bosque 1
Mina de ferro 1
Pedra 2
Bosque 2
Pedra 3
Bosque 3
Fazenda 1
Pedra 4
Mina de ferro 2
Fazenda 2
Bosque 4
Pedra 5
Main 2
Main 3
Main 4
Main 5
Quartel 1
Quartel 2
Storage 1
Quartel 3
Storage 2
Fazenda 3
Bosque 5
Pedra 6
Mina de ferro 3
Fazenda 4
Storage 3
Storage 4
Fazenda 5
Ferreiro 1
Ferreiro 2
Ferreiro 3
Main 6
Storage 5
Storage 6
Mina de ferro 4
Mina de ferro 5
Fazenda 6
Main 7
Bosque 6
Bosque 7
Bosque 8
Bosque 9
Bosque 10
Pedra 7
Pedra 8
Pedra 9
Pedra 10
Fazenda 7
Mercado 1
Mercado 2
Main 8
Quartel 4
Fazenda 8
Main 9
Quartel 5
Muralha 1
Muralha 2
Muralha 3
Muralha 4
Muralha 5
Mina de ferro 6
Ferreiro 4
Fazenda 9
Ferreiro 5
Fazenda 10
Main 10
Stable 1
Fazenda 11
Stable 2
Stable 3
Mina de ferro 7
Stable 4
Stable 5
Fazenda 12
Bosque 11
Bosque 12
Bosque 13
Bosque 14
Bosque 15
Pedra 11
Pedra 12
Pedra 13
Pedra 14
Pedra 15
Mina de ferro 8
Mina de ferro 9
Mina de ferro 10
Ferreiro 6
Ferreiro 7
Ferreiro 8
Ferreiro 9
Ferreiro 10
Oficina 1
Oficina 2
Oficina 3
Mina de ferro 11
Mina de ferro 12
Mina de ferro 13
Mina de ferro 14
Mina de ferro 15
Main 11
Main 12
Main 13
Main 14
Main 15
Fazenda 13
Fazenda 14
Muralha 6
Muralha 7
Muralha 8
Muralha 9
Muralha 10
Quartel 6
Quartel 7
Quartel 8
Quartel 9
Quartel 10
Bosque 16
Pedra 16
Bosque 17
Pedra 17
Fazenda 15
Bosque 18
Pedra 18
Bosque 19
Pedra 19
Bosque 20
Pedra 20
Main 16
Main 17
Main 18
Main 19
Main 20
Bosque 21
Pedra 21
Bosque 22
Pedra 22
Fazenda 16
Quartel 11
Quartel 12
Quartel 13
Quartel 14
Quartel 15
Stable 6
Stable 7
Stable 8
Stable 9
Stable 10
Stable 11
Stable 12
Stable 13
Stable 14
Stable 15
Ferreiro 11
Ferreiro 12
Ferreiro 13
Ferreiro 14
Ferreiro 15
Mina de ferro 16
Mina de ferro 17
Mina de ferro 18
Mina de ferro 19
Mina de ferro 20
Fazenda 17
Mercado 3
Mercado 4
Mercado 5
Mercado 6
Mercado 7
Mercado 8
Mercado 9
Mercado 10
Quartel 16
Quartel 17
Quartel 18
Quartel 19
Quartel 20
Bosque 23
Pedra 23
Fazenda 18
Bosque 24
Pedra 24
Mercado 11
Mercado 12
Mercado 13
Mercado 14
Mercado 15
Ferreiro 16
Ferreiro 17
Ferreiro 18
Ferreiro 19
Ferreiro 20
Academia 1
Bosque 25
Pedra 25
Mina de ferro 21
Mina de ferro 22
Mina de ferro 23
Mina de ferro 24
Mina de ferro 25
Bosque 26
Pedra 26
Mina de ferro 26
Bosque 27
Pedra 27
Bosque 28
Pedra 28
Bosque 29
Pedra 29
Bosque 30
Pedra 30
Fazenda 19
Fazenda 20
Fazenda 21
Fazenda 22
Fazenda 23
Fazenda 24
Fazenda 25
Fazenda 26
Fazenda 27
Fazenda 28
Fazenda 29
Fazenda 30
Storage 7
Storage 8
Storage 9
Storage 10
Storage 11
Storage 12
Storage 13
Storage 14
Storage 15
Storage 16
Storage 17
Storage 18
Storage 19
Storage 20
Storage 21
Storage 22
Storage 23
Storage 24
Storage 25
Storage 26
Storage 27
Storage 28
Storage 29
Storage 30`
,
        defense: `Main 1
Statue 1
Pedra 1
Bosque 1
Mina de ferro 1
Pedra 2
Bosque 2
Pedra 3
Bosque 3
Mina de ferro 2
Bosque 4
Pedra 4
Storage 1
Bosque 5
Pedra 5
Bosque 6
Mina de ferro 3
Pedra 6
Storage 2
Main 3
Quartel 1
Storage 3
Quartel 2
Bosque 7
Mercado 1
Storage 4
Bosque 9
Pedra 7
Bosque 10
Pedra 8
Bosque 11
Storage 5
Fazenda 2
Pedra 9
Mina de ferro 4
Bosque 12
Pedra 10
Storage 6
Fazenda 3
Quartel 5
Muralha 5
Bosque 13
Storage 7
Pedra 11
Mina de ferro 6
Fazenda 4
Main 5
Ferreiro 2
Bosque 14
Pedra 12
Fazenda 5
Storage 9
Bosque 15
Mina de ferro 10
Pedra 13
Storage 10
Main 10
Fazenda 8
Storage 11
Bosque 16
Pedra 15
Mina de ferro 14
Quartel 12
Ferreiro 5
Stable 3
Muralha 10
Mercado 5
Fazenda 11
Storage 12
Pedra 16
Bosque 17
Mina de ferro 15
Ferreiro 8
Mercado 6
Ferreiro 10
Quartel 13
Bosque 18
Pedra 17
Storage 16
Fazenda 16
Quartel 14
Muralha 15
Pedra 18
Main 15
Bosque 19
Oficina 3
Stable 5
Pedra 19
Main 20
Stable 10
Stable 15
Ferreiro 15
Muralha 20
Fazenda 18
Storage 17
Bosque 20
Pedra 22
Bosque 21
Mina de ferro 18
Fazenda 21
Storage 19
Bosque 22
Mercado 10
Quartel 18
Pedra 24
Quartel 19
Storage 22
Fazenda 22
Pedra 25
Fazenda 23
Quartel 20
Quartel 23
Bosque 24
Mina de ferro 21
Quartel 24
Ferreiro 20
Quartel 25
Stable 20
Bosque 25
Mina de ferro 25
Pedra 26
Fazenda 25
Mercado 15
Mina de ferro 26
Storage 25
Academia 1
Bosque 26
Bosque 27
Pedra 27
Bosque 28
Pedra 28
Storage 27
Fazenda 27
Pedra 29
Bosque 29
Mina de ferro 27
Fazenda 28
Mina de ferro 28
Storage 28
Storage 29
Pedra 30
Bosque 30
Mina de ferro 30
Fazenda 30`
,
       resources: `Main 1
Statue 1
Pedra 1
Bosque 1
Mina de ferro 1
Pedra 2
Bosque 2
Mina de ferro 2
Storage 1
Pedra 3
Bosque 3
Mina de ferro 3
Fazenda 1
Pedra 4
Bosque 4
Mina de ferro 4
Storage 2
Main 2
Main 3
Main 4
Bosque 5
Pedra 5
Mina de ferro 5
Storage 3
Storage 4
Fazenda 2
Bosque 6
Pedra 6
Mina de ferro 6
Storage 5
Fazenda 3
Main 5
Mercado 1
Mercado 2
Bosque 7
Pedra 7
Mina de ferro 7
Storage 6
Fazenda 4
Main 6
Bosque 8
Pedra 8
Mina de ferro 8
Storage 7
Bosque 9
Pedra 9
Mina de ferro 9
Fazenda 5
Main 7
Bosque 10
Pedra 10
Mina de ferro 10
Storage 8
Main 8
Mercado 3
Mercado 4
Bosque 11
Pedra 11
Mina de ferro 11
Storage 9
Fazenda 6
Main 9
Bosque 12
Pedra 12
Mina de ferro 12
Storage 10
Main 10
Fazenda 7
Bosque 13
Pedra 13
Mina de ferro 13
Storage 11
Bosque 14
Pedra 14
Mina de ferro 14
Storage 12
Main 11
Fazenda 8
Bosque 15
Pedra 15
Mina de ferro 15
Storage 13
Main 12
Bosque 16
Pedra 16
Mina de ferro 16
Storage 14
Bosque 17
Pedra 17
Mina de ferro 17
Fazenda 9
Storage 15
Main 13
Bosque 18
Pedra 18
Mina de ferro 18
Storage 16
Main 14
Bosque 19
Pedra 19
Mina de ferro 19
Storage 17
Fazenda 10
Bosque 20
Pedra 20
Mina de ferro 20
Storage 18
Main 15
Bosque 21
Pedra 21
Mina de ferro 21
Storage 19
Bosque 22
Pedra 22
Mina de ferro 22
Storage 20
Main 16
Fazenda 11
Bosque 23
Pedra 23
Mina de ferro 23
Storage 21
Bosque 24
Pedra 24
Mina de ferro 24
Storage 22
Main 17
Fazenda 12
Bosque 25
Pedra 25
Mina de ferro 25
Storage 23
Main 18
Fazenda 13
Bosque 26
Pedra 26
Mina de ferro 26
Storage 24
Bosque 27
Pedra 27
Mina de ferro 27
Storage 25
Main 19
Bosque 28
Pedra 28
Mina de ferro 28
Storage 26
Fazenda 14
Bosque 29
Pedra 29
Mina de ferro 29
Storage 27
Main 20
Bosque 30
Pedra 30
Mina de ferro 30
Storage 28
Fazenda 15
Storage 29
Fazenda 16
Storage 30
Fazenda 17
Fazenda 18
Fazenda 19
Fazenda 20
Fazenda 21
Fazenda 22
Fazenda 23
Fazenda 24
Fazenda 25
Fazenda 26
Fazenda 27
Fazenda 28
Fazenda 29
Fazenda 30`

    };


    return orders[profile] || ''; // Retorna as ordens ou vazio caso não encontre
}


















































// Salva ordens inseridas por texto
function saveOrderByText() {
    const textarea = document.getElementById('order-textarea');
    const lines = textarea.value.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    const orders = [];


    for (const line of lines) {
        // Captura pares "nome número" em cada linha (exemplo: "Main 10")
        const matches = line.match(/([a-zA-Z\s]+)\s+(\d+)/g);
        if (!matches) {
            alert(`Linha inválida: "${line}". Use o formato Edifício Nível (exemplo: "Main 10").`);
            return;
        }


        for (const match of matches) {
            const [_, buildingName, level] = match.match(/([a-zA-Z\s]+)\s+(\d+)/); // Separa nome e nível
            const buildingId = getBuildingIdFromName(buildingName.trim());


            if (buildingId && !isNaN(level)) {
                orders.push({ id: buildingId, level: parseInt(level, 10) });
            } else {
                alert(`Nome de edifício inválido ou nível não numérico: "${buildingName}".`);
                return;
            }
        }
    }


    // Atualiza a configuração global
    recruitmentConfig.order = orders;


    // Salva no localStorage ou sistema de persistência
    saveRecruitmentConfig();


    alert('Ordens adicionadas com sucesso!');
    closePopup();
}


// Função para mapear nomes para IDs
function getBuildingIdFromName(name) {
    name = name.trim().toLowerCase();
    const buildingNames = {
        main: ["main", "main building", "edifício principal"],
        statue: ["statue", "estátua"],
        wood: ["wood", "woodcutter", "bosque"],
        clay: ["clay", "clay pit", "poço de argila", "argila", "barro", "stone", "pedra"], // Correção: inclui "stone" e "pedra"
        iron: ["iron", "iron mine", "mina de ferro", "ferro"],
        farm: ["farm", "fazenda"],
        storage: ["storage", "armazém"],
        hide: ["hide", "hideout", "esconderijo"],
        barracks: ["barracks", "quartel"],
        stable: ["stable", "estábulo"],
        workshop: ["workshop", "oficina"],
        watchtower: ["watchtower", "torre de vigia"],
        academy: ["academy", "academia"],
        smith: ["smith", "smithy", "ferreiro"],
        market: ["market", "mercado"],
        wall: ["wall", "muralha"]
    };

    for (const [id, names] of Object.entries(buildingNames)) {
        if (names.some(n => n.toLowerCase() === name)) {
            console.log(`Nome de entrada: ${name}, ID retornado: ${id}`);
            return id;
        }
    }
    console.log(`Nome de entrada: ${name}, ID retornado: null`);
    return null;
}


/*// Exemplo de função de persistência (ajuste conforme necessário)
function saveRecruitmentConfig() {
    localStorage.setItem('recruitmentConfig', JSON.stringify(recruitmentConfig));
}*/





























// Função para abrir o popup de configurações de construção
function openConstructionOrdersPopup() {
    const savedOrder = recruitmentConfig.order || [];

    // Mapear os ícones por ID dos edifícios
    const buildingIcons = {
        main: "🏛️",
        statue: "🗿",
        wood: "🌲",
        clay: "🏺",
        iron: "⛓️",
        farm: "🌾",
        storage: "📦",
        hide: "🏚️",
        barracks: "🛡️",
        stable: "🐎",
        workshop: "🔧",
        watchtower: "🔭",
        academy: "🎓",
        smith: "⚒️",
        market: "💰",
        wall: "🏰"
    };

    // Gera os cartões com base na ordem salva
    const cards = savedOrder.map(({ id, level }) => {
        const buildingIcon = buildingIcons[id] || "❓";
        const buildingName = getBuildingName(id.charAt(0).toUpperCase() + id.slice(1));

        return `
            <div class="draggable-card" data-id="${id}" data-level="${level}">
                <div class="card-icon">${buildingIcon}</div>
                <div class="card-info">
                    <span class="card-title">${buildingName}</span>
                    <span class="card-level">Nível ${level}</span>
                </div>
                <button class="delete-card-btn" data-id="${id}" data-level="${level}">
                    ✖
                </button>
            </div>
        `;
    }).join('');

    const content = `
    <div class="popup-wrapper">
        <div class="popup-header">
            <h2>📜 Configurações de Construção</h2>
            <p>Arraste para ajustar a ordem ou exclua itens indesejados.</p>
        </div>
        <div class="popup-body">
            <div id="construction-orders-container" class="card-container">
                ${cards || `<div class="empty-message">Nenhuma configuração de edifício salva.</div>`}
            </div>
        </div>
        <div class="popup-footer">
            <button id="start-automatic-build" class="popup-btn btn-green">Ativar Automação</button>
            <button id="save-order" class="popup-btn btn-blue">Salvar Ordem</button>
            <button id="clear-village-state" class="popup-btn btn-red" style="background: #e67e22;">Limpar Estado</button>
            <button id="close-popup-orders" class="popup-btn btn-red">Fechar</button>
        </div>
        <div style="margin-top: 15px; padding: 10px; background: #ecf0f1; border-radius: 8px; font-size: 12px;">
            <strong>📊 Estado da Aldeia:</strong>
            <div id="village-state-info" style="margin-top: 5px; color: #34495e;">Carregando...</div>
        </div>
    </div>



    <style>
        /* Estilos gerais do pop-up */
        .popup-wrapper {
            width: 600px;
            background: linear-gradient(145deg, #f7f8fa, #e3e6ed);
            border-radius: 15px;
            box-shadow: 0 10px 20px rgba(0, 0, 0, 0.1);
            padding: 20px;
            font-family: 'Arial', sans-serif;
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            animation: fadeIn 0.3s ease;
        }

        .popup-header {
            text-align: center;
            border-bottom: 2px solid #3498db;
            margin-bottom: 20px;
            padding-bottom: 10px;
        }

        .popup-header h2 {
            font-size: 22px;
            color: #2c3e50;
            margin: 0;
        }

        .popup-header p {
            font-size: 14px;
            color: #7f8c8d;
            margin: 5px 0 0;
        }

        .popup-body {
            max-height: 300px;
            overflow-y: auto;
        }

        .card-container {
            display: flex;
            flex-wrap: wrap;
            gap: 15px;
            justify-content: center;
        }

        .draggable-card {
            background: #ffffff;
            border-radius: 10px;
            padding: 10px;
            box-shadow: 0 4px 10px rgba(0, 0, 0, 0.1);
            display: flex;
            flex-direction: column;
            align-items: center;
            text-align: center;
            width: 120px;
            position: relative;
            transition: transform 0.2s ease;
        }

        .draggable-card:hover {
            transform: scale(1.05);
        }

        .card-icon {
            font-size: 30px;
            margin-bottom: 10px;
        }

        .card-info {
            font-size: 14px;
            color: #2c3e50;
        }

        .card-title {
            font-weight: bold;
        }

        .card-level {
            font-size: 12px;
            color: #7f8c8d;
        }

        .delete-card-btn {
            position: absolute;
            top: 5px;
            right: 5px;
            background: #e74c3c;
            color: #fff;
            border: none;
            border-radius: 50%;
            width: 20px;
            height: 20px;
            font-size: 12px;
            cursor: pointer;
            transition: background 0.2s ease;
        }

        .delete-card-btn:hover {
            background: #c0392b;
        }

        .empty-message {
            text-align: center;
            font-size: 14px;
            color: #95a5a6;
        }

        .popup-footer {
            margin-top: 20px;
            text-align: center;
        }

        .popup-btn {
            padding: 10px 20px;
            border-radius: 10px;
            border: none;
            color: #fff;
            font-size: 14px;
            cursor: pointer;
            margin: 5px;
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
        }

        .btn-green {
            background: #2ecc71;
        }

        .btn-blue {
            background: #3498db;
        }

        .btn-red {
            background: #e74c3c;
        }

        .btn-green:hover {
            background: #27ae60;
        }

        .btn-blue:hover {
            background: #2980b9;
        }

        .btn-red:hover {
            background: #c0392b;
        }

        @keyframes fadeIn {
            from {
                opacity: 0;
                transform: translate(-50%, -60%);
            }
            to {
                opacity: 1;
                transform: translate(-50%, -50%);
            }
        }
    </style>
    `;

     createPopup(content);


    // Atualiza o texto do botão com base no estado atual
    updateAutomationButton();

     // Adiciona o evento ao botão "Ativar Automação" no pop-up
    document.getElementById('start-automatic-build').addEventListener('click', toggleBuildAutomation);


    // Adiciona os eventos de drag and drop com SortableJS
    addDragAndDropEvents();

    // Adiciona o evento para fechar o pop-up
    document.getElementById('close-popup-orders').addEventListener('click', closePopup);

    // Salva a ordem
    document.getElementById('save-order').addEventListener('click', saveOrder);
    
    // Limpa estado da aldeia
    document.getElementById('clear-village-state').addEventListener('click', () => {
        if (confirm('Tem certeza que deseja limpar todo o estado persistente desta aldeia? Isso resetará cooldowns, bloqueios e contadores.')) {
            clearVillageState();
            alert('Estado da aldeia limpo com sucesso!');
            // Atualiza display do estado
            displayVillageStateInfo();
        }
    });

     // Carrega o estado da automação do localStorage
    isBuildAutomationActive = localStorage.getItem('isBuildAutomationActive') === 'true';

    // Adiciona o evento ao botão "Ativar Automação" no pop-up
    document.getElementById('start-automatic-build').addEventListener('click', toggleBuildAutomation);
    
    // Exibe informações do estado da aldeia
    displayVillageStateInfo();

    // Adiciona eventos de exclusão aos botões
    document.querySelectorAll('.delete-card-btn').forEach(button => {
        button.addEventListener('click', (e) => {
            const id = button.getAttribute('data-id');
            const level = button.getAttribute('data-level');
            deleteCard(id, level);
        });
    });
}

/**
 * Exibe informações do estado da aldeia no popup
 */
function displayVillageStateInfo() {
    const stateInfoDiv = document.getElementById('village-state-info');
    if (!stateInfoDiv) return;
    
    const state = loadVillageState();
    const now = Date.now();
    
    const blockedCount = state.blockedTargets.filter(b => b.until > now).length;
    const cooldownRemaining = state.cooldownUntil > now ? Math.ceil((state.cooldownUntil - now) / 1000) : 0;
    
    stateInfoDiv.innerHTML = `
        <div><strong>Último target:</strong> ${state.lastTarget ? `${state.lastTarget.id} nível ${state.lastTarget.level}` : 'Nenhum'}</div>
        <div><strong>Último sucesso:</strong> ${state.lastSuccess ? new Date(state.lastSuccess).toLocaleTimeString() : 'Nunca'}</div>
        <div><strong>Último erro:</strong> ${state.lastError ? new Date(state.lastError).toLocaleTimeString() : 'Nunca'}</div>
        <div><strong>Falhas consecutivas:</strong> ${state.consecutiveFailures}</div>
        <div><strong>Cooldown:</strong> ${cooldownRemaining > 0 ? `${cooldownRemaining}s restantes` : 'Nenhum'}</div>
        <div><strong>Targets bloqueados:</strong> ${blockedCount}</div>
        <div><strong>Milestone atual:</strong> ${state.currentMilestone}</div>
        <div><strong>Action Lock:</strong> ${state.actionLock ? '🔒 ATIVO' : '🔓 inativo'}</div>
        ${state.previousBottleneck ? `<div><strong>Gargalo anterior:</strong> ${state.previousBottleneck.resource}</div>` : ''}
    `;
}


















































































// Variável para rastrear o último nível verificado para cada edifício
let lastCheckedLevels = {};
let popupClosed = false; // Flag para controlar o fechamento do popup
let observer; // Armazena o observador para permitir desconexão
let pageUpdated = false; // Variável para rastrear se houve uma atualização relevante na página


// Configura um MutationObserver para monitorar alterações no DOM
function setupPageObserver() {
    console.log("Configurando observador de alterações na página...");


    const targetNode = document.querySelector('#buildings'); // Alvo: container principal de edifícios
    if (!targetNode) {
        console.warn("Elemento principal de edifícios não encontrado. O observador não será configurado.");
        return;
    }


    observer = new MutationObserver(mutations => {
        for (const mutation of mutations) {
            if (mutation.type === 'childList' || mutation.type === 'attributes') {
                console.log("Alteração detectada na página.");
                pageUpdated = true; // Sinaliza que houve uma atualização
                break;
            }
        }
    });


    observer.observe(targetNode, { childList: true, attributes: true, subtree: true });
}


// Função para coletar recompensas automáticas
async function collectRewards() {
    console.log("Verificando recompensas automáticas...");


    const questButton = document.querySelector('#new_quest');
    if (!questButton) {
        console.log("Botão de recompensas não encontrado.");
        return;
    }


    console.log("Abrindo o popup de recompensas...");
    questButton.click();
    await waitForPopupToOpen();


    const rewardTabButton = document.querySelector('a.tab-link[data-tab="reward-tab"]');
    if (!rewardTabButton) {
        console.log("Aba de recompensas não encontrada. Fechando popup.");
        closeRewardsPopup();
        return;
    }


    console.log("Abrindo a aba de recompensas...");
    rewardTabButton.click();
    await waitForRewardsToLoad();


    // Procura por recompensas enquanto o popup estiver aberto
    while (isPopupOpen()) {
        const claimButtons = document.querySelectorAll('a.btn.btn-confirm-yes.reward-system-claim-button');
        if (claimButtons.length === 0) {
            console.log("Nenhuma recompensa disponível. Fechando popup.");
            closeRewardsPopup();
            return;
        }


        for (const button of claimButtons) {
            if (canClaimReward(button)) {
                console.log("Reivindicando recompensa...");
                button.click();
                await wait(1500);
            } else {
                console.warn("Recompensa não pode ser reivindicada: Armazém cheio.");
                closeRewardsPopup();
                return;
            }
        }


        // Aguarda um pouco antes de verificar novamente
        await wait(1000);
    }
}





// Função auxiliar para verificar se a recompensa pode ser reivindicada
function canClaimReward(button) {
    const rewardContainer = button.closest('.reward-container');
    return !(rewardContainer && rewardContainer.innerText.includes("Armazém não suporta"));
}










// Função auxiliar para aguardar o popup abrir
async function waitForPopupToOpen() {
    await wait(1000);
}


// Função auxiliar para aguardar as recompensas carregarem
async function waitForRewardsToLoad() {
    await wait(1000);
}


// Função para fechar o popup de recompensas simulando o pressionamento da tecla ESC
function closeRewardsPopup() {
    console.log("Tentando fechar o popup...");
    if (!popupClosed) {
        console.log("Popup não está marcado como fechado. Tentando simular ESC...");


        // Desconecta o observador temporariamente
        if (observer) {
            observer.disconnect();
            console.log("Observador desconectado temporariamente.");
        }


        const escEvent = new KeyboardEvent('keydown', {
            key: 'Escape',
            keyCode: 27,
            code: 'Escape',
            which: 27,
            bubbles: true,
            cancelable: true
        });


        document.dispatchEvent(escEvent);
        console.log("Simulando pressionamento da tecla ESC para fechar o popup.");
        popupClosed = true; // Marca que o popup foi fechado


        // Reconecta o observador após um tempo de espera
        setTimeout(() => {
            if (observer) {
                setupPageObserver();
                console.log("Observador reconectado.");
            }
        }, 2000);
    } else {
        console.log("Popup já está marcado como fechado. Nenhuma ação necessária.");
    }
}


// Função para verificar se o popup está aberto
function isPopupOpen() {
    const popup = document.querySelector('.popup_box');
    const isOpen = popup && popup.style.display !== 'none';
    console.log(`Verificação de popup: ${isOpen ? 'Aberto' : 'Fechado'}`);
    return isOpen;
}


// Função para verificar níveis concluídos
function checkBuildingLevels() {
    console.log("Verificando níveis concluídos...");
    let levelUpdated = false;


    const buildingRows = document.querySelectorAll('.building-row');
    buildingRows.forEach(row => {
        const buildingId = row.getAttribute('data-building');
        const currentLevel = parseInt(row.querySelector('.level-indicator')?.innerText || "0", 10);


        if (lastCheckedLevels[buildingId] !== undefined && currentLevel > lastCheckedLevels[buildingId]) {
            console.log(`Nível concluído para ${buildingId}: ${currentLevel}`);
            levelUpdated = true;
        }


        lastCheckedLevels[buildingId] = currentLevel;
    });


    return levelUpdated;
}


// Função auxiliar para aguardar (em milissegundos)
function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


































// Variável para controlar o estado da automação de construção (agora global)
let isBuildAutomationActive = false;

// Prefixo para chaves do localStorage
const LS_PREFIX = 'tw_automation_';

/**
 * Obtém a chave única para o estado da aldeia
 * @returns {string} Chave do localStorage para a aldeia atual
 */
function getVillageStorageKey() {
    const villageId = game_data?.village?.id || new URLSearchParams(window.location.search).get('village') || 'unknown';
    return `${LS_PREFIX}village_${villageId}_state`;
}

/**
 * Estrutura padrão do estado da aldeia
 * @returns {Object} Estado inicial da aldeia
 */
function getDefaultVillageState() {
    return {
        lastTarget: null,           // Último edifício tentado {id, level}
        lastSuccess: 0,             // Timestamp do último sucesso
        lastError: 0,               // Timestamp do último erro
        cooldownUntil: 0,           // Timestamp até quando esperar (cooldown)
        consecutiveFailures: 0,     // Contador de falhas consecutivas
        blockedTargets: [],         // Lista de targets problemáticos [{id, level, until}]
        previousBottleneck: null,   // Gargalo anterior identificado {resource: 'wood'|'clay'|'iron', amount}
        currentMilestone: 0,        // Marco atual (índice na ordem de construção)
        actionLock: false,          // Bloqueio de ação em andamento
        lastActionTime: 0           // Timestamp da última ação
    };
}

/**
 * Carrega o estado persistente da aldeia atual
 * @returns {Object} Estado da aldeia
 */
function loadVillageState() {
    try {
        const key = getVillageStorageKey();
        const saved = localStorage.getItem(key);
        if (saved) {
            const state = JSON.parse(saved);
            // Merge com valores padrão para garantir todos os campos
            return { ...getDefaultVillageState(), ...state };
        }
    } catch (e) {
        console.error('Erro ao carregar estado da aldeia:', e);
    }
    return getDefaultVillageState();
}

/**
 * Salva o estado persistente da aldeia atual
 * @param {Object} state - Estado a ser salvo
 */
function saveVillageState(state) {
    try {
        const key = getVillageStorageKey();
        state.lastUpdated = Date.now();
        localStorage.setItem(key, JSON.stringify(state));
    } catch (e) {
        console.error('Erro ao salvar estado da aldeia:', e);
    }
}

/**
 * Limpa o estado da aldeia (reset completo)
 */
function clearVillageState() {
    try {
        const key = getVillageStorageKey();
        localStorage.removeItem(key);
        console.log(`Estado da aldeia ${game_data?.village?.id || 'desconhecida'} limpo.`);
    } catch (e) {
        console.error('Erro ao limpar estado da aldeia:', e);
    }
}

/**
 * Verifica se um target está bloqueado
 * @param {string} id - ID do edifício
 * @param {number} level - Nível do edifício
 * @returns {boolean} True se estiver bloqueado
 */
function isTargetBlocked(id, level) {
    const state = loadVillageState();
    const now = Date.now();
    
    // Filtra blocos expirados
    state.blockedTargets = state.blockedTargets.filter(block => block.until > now);
    
    // Verifica se o target atual está bloqueado
    const isBlocked = state.blockedTargets.some(
        block => block.id === id && block.level === level
    );
    
    if (isBlocked) {
        const block = state.blockedTargets.find(b => b.id === id && b.level === level);
        const remaining = Math.ceil((block.until - now) / 1000);
        console.warn(`Target ${id} nível ${level} está bloqueado por mais ${remaining}s`);
    }
    
    saveVillageState(state);
    return isBlocked;
}

/**
 * Bloqueia um target temporariamente
 * @param {string} id - ID do edifício
 * @param {number} level - Nível do edifício
 * @param {number} durationMs - Duração do bloqueio em ms (padrão: 5 minutos)
 */
function blockTarget(id, level, durationMs = 300000) {
    const state = loadVillageState();
    const now = Date.now();
    
    // Remove bloco existente se houver
    state.blockedTargets = state.blockedTargets.filter(
        block => !(block.id === id && block.level === level)
    );
    
    // Adiciona novo bloco
    state.blockedTargets.push({
        id,
        level,
        until: now + durationMs,
        reason: 'falha_repetida'
    });
    
    state.lastError = now;
    saveVillageState(state);
    console.warn(`Target ${id} nível ${level} bloqueado por ${durationMs/1000}s`);
}

/**
 * Libera todos os blocos expirados e retorna lista de blocos ativos
 * @returns {Array} Lista de targets bloqueados
 */
function cleanupBlockedTargets() {
    const state = loadVillageState();
    const now = Date.now();
    const previousCount = state.blockedTargets.length;
    
    state.blockedTargets = state.blockedTargets.filter(block => block.until > now);
    
    if (state.blockedTargets.length !== previousCount) {
        console.log(`${previousCount - state.blockedTargets.length} bloqueios expirados removidos`);
    }
    
    saveVillageState(state);
    return state.blockedTargets;
}

/**
 * Define cooldown após falha
 * @param {number} durationMs - Duração do cooldown em ms
 */
function setCooldown(durationMs = 60000) {
    const state = loadVillageState();
    state.cooldownUntil = Date.now() + durationMs;
    state.lastError = Date.now();
    saveVillageState(state);
    console.log(`Cooldown definido por ${durationMs/1000}s`);
}

/**
 * Verifica se está em período de cooldown
 * @returns {boolean} True se estiver em cooldown
 */
function isInCooldown() {
    const state = loadVillageState();
    const now = Date.now();
    
    if (now < state.cooldownUntil) {
        const remaining = Math.ceil((state.cooldownUntil - now) / 1000);
        console.log(`Em cooldown, aguardando ${remaining}s...`);
        return true;
    }
    
    return false;
}

/**
 * Registra sucesso na construção
 * @param {string} id - ID do edifício construído
 * @param {number} level - Nível construído
 */
function registerSuccess(id, level) {
    const state = loadVillageState();
    const now = Date.now();
    
    state.lastTarget = { id, level };
    state.lastSuccess = now;
    state.lastActionTime = now;
    state.consecutiveFailures = 0; // Reseta contador de falhas
    state.actionLock = false; // Libera lock
    
    // Atualiza milestone
    state.currentMilestone++;
    
    // Limpa cooldown
    state.cooldownUntil = 0;
    
    saveVillageState(state);
    console.log(`Sucesso registrado: ${id} nível ${level}. Milestone: ${state.currentMilestone}`);
}

/**
 * Registra falha na construção
 * @param {string} id - ID do edifício
 * @param {number} level - Nível tentado
 * @param {string} reason - Motivo da falha
 */
function registerFailure(id, level, reason = 'desconhecido') {
    const state = loadVillageState();
    const now = Date.now();
    
    state.lastTarget = { id, level };
    state.lastError = now;
    state.lastActionTime = now;
    state.consecutiveFailures++;
    state.actionLock = false; // Libera lock
    
    console.warn(`Falha registrada: ${id} nível ${level}. Motivo: ${reason}. Falhas consecutivas: ${state.consecutiveFailures}`);
    
    // Ações baseadas no número de falhas consecutivas
    if (state.consecutiveFailures >= 3) {
        // Após 3 falhas, bloqueia o target
        blockTarget(id, level, 300000); // 5 minutos
        setCooldown(120000); // 2 minutos de cooldown geral
        console.error(`Múltiplas falhas detectadas. Target bloqueado e cooldown ativado.`);
    } else if (state.consecutiveFailures >= 2) {
        // Após 2 falhas, aumenta cooldown
        setCooldown(60000); // 1 minuto
    } else {
        // Primeira falha, cooldown curto
        setCooldown(30000); // 30 segundos
    }
    
    saveVillageState(state);
}

/**
 * Tenta adquirir lock de ação
 * @returns {boolean} True se conseguiu adquirir o lock
 */
function tryAcquireActionLock() {
    const state = loadVillageState();
    
    if (state.actionLock) {
        console.log('Ação já está em andamento (actionLock ativo)');
        return false;
    }
    
    state.actionLock = true;
    state.lastActionTime = Date.now();
    saveVillageState(state);
    return true;
}

/**
 * Libera o lock de ação
 */
function releaseActionLock() {
    const state = loadVillageState();
    state.actionLock = false;
    saveVillageState(state);
}

/**
 * Identifica e armazena gargalo de recursos
 * @param {Object} resources - Recursos atuais {wood, clay, iron}
 * @param {Object} costs - Custos da construção {wood, clay, iron}
 */
function identifyBottleneck(resources, costs) {
    const state = loadVillageState();
    
    const ratios = {
        wood: resources.madeira / (costs.wood || 1),
        clay: resources.argila / (costs.clay || 1),
        iron: resources.ferro / (costs.iron || 1)
    };
    
    // Encontra o recurso com menor ratio (gargalo)
    let minRatio = Infinity;
    let bottleneck = null;
    
    for (const [resource, ratio] of Object.entries(ratios)) {
        if (ratio < minRatio) {
            minRatio = ratio;
            bottleneck = { resource, ratio, needed: costs[resource] - resources[resource.replace('wood', 'madeira').replace('clay', 'argila').replace('iron', 'ferro')] };
        }
    }
    
    state.previousBottleneck = bottleneck;
    saveVillageState(state);
    
    if (bottleneck) {
        console.log(`Gargalo identificado: ${bottleneck.resource} (ratio: ${bottleneck.ratio.toFixed(2)})`);
    }
    
    return bottleneck;
}

// Função para carregar o estado salvo do localStorage e mostrar no console
function loadAutomationState() {
    // Verifica se o estado foi salvo no localStorage
    const savedState = localStorage.getItem('isBuildAutomationActive');
    if (savedState !== null) {
        // Converte o estado salvo para booleano
        isBuildAutomationActive = savedState === 'true';
    }

    // Carrega e exibe estado da aldeia
    const villageState = loadVillageState();
    console.log('=== ESTADO DA ALDEIA ===');
    console.log(`Último target: ${villageState.lastTarget ? `${villageState.lastTarget.id} nível ${villageState.lastTarget.level}` : 'Nenhum'}`);
    console.log(`Último sucesso: ${villageState.lastSuccess ? new Date(villageState.lastSuccess).toLocaleTimeString() : 'Nunca'}`);
    console.log(`Último erro: ${villageState.lastError ? new Date(villageState.lastError).toLocaleTimeString() : 'Nunca'}`);
    console.log(`Falhas consecutivas: ${villageState.consecutiveFailures}`);
    console.log(`Cooldown até: ${villageState.cooldownUntil ? new Date(villageState.cooldownUntil).toLocaleTimeString() : 'Nenhum'}`);
    console.log(`Targets bloqueados: ${villageState.blockedTargets.length}`);
    console.log(`Milestone atual: ${villageState.currentMilestone}`);
    console.log(`Action Lock: ${villageState.actionLock ? 'ATIVO' : 'inativo'}`);
    console.log('========================');

    // Exibe no console se a automação está ativada ou desativada
    console.log(`Automação de construção está ${isBuildAutomationActive ? 'Ativada' : 'Desativada'}`);

    // Atualiza o botão com base no estado salvo
    updateAutomationButton();
}

// Função para alternar o estado da automação de construção
function toggleBuildAutomation() {
    isBuildAutomationActive = !isBuildAutomationActive;
    console.log(`Estado alterado: ${isBuildAutomationActive ? "Ativado" : "Desativado"}`);

    // Salva o estado no localStorage
    localStorage.setItem('isBuildAutomationActive', isBuildAutomationActive);

    // Atualiza o texto do botão
    updateAutomationButton();

    if (isBuildAutomationActive) {
        console.log("Automação de construção ativada!");
        executeBuildOrder();
    } else {
        console.log("Automação de construção desativada!");
    }
}

// Função para atualizar o texto do botão com base no estado atual
function updateAutomationButton() {
    const button = document.getElementById('start-automatic-build');
    if (button) {
        button.textContent = isBuildAutomationActive ? "Desativar Automação" : "Ativar Automação";
        console.log(`Estado do botão atualizado para: ${button.textContent}`);
    } else {
        console.warn("Botão 'start-automatic-build' não encontrado no DOM.");
    }
}

// Carregar o estado salvo ao iniciar a página
window.addEventListener('load', loadAutomationState);








// Variável global para rastrear se a automação já foi executada após a atualização da página
let hasExecutedBuildOrder = false;

// Função principal para executar a lógica de construção automática
async function executeBuildOrder() {
    const villagePagePattern = /https:\/\/br131\.tribalwars\.com\.br\/game\.php\?village=\d+&screen=main/;

    if (!villagePagePattern.test(window.location.href) || !isBuildAutomationActive || hasExecutedBuildOrder) {
        return; // Não executa se a URL não for a correta ou a automação não estiver ativada
    }

    // Carrega estado persistente da aldeia
    let villageState = loadVillageState();
    
    // Verifica cooldown inicial
    if (isInCooldown()) {
        const waitTime = villageState.cooldownUntil - Date.now();
        if (waitTime > 0) {
            console.log(`Aguardando cooldown (${Math.ceil(waitTime/1000)}s)...`);
            await wait(Math.min(waitTime, 300000)); // Espera até 5 minutos máximo
            villageState = loadVillageState(); // Recarrega estado após espera
        }
    }

    // Limpa blocos expirados
    cleanupBlockedTargets();

    let buildOrder = [...recruitmentConfig.order]; // Cópia da ordem de construção configurada
    const executionConfig = recruitmentConfig.execution || {
        mode: "followOrder", // Pode ser 'followOrder' ou 'opportunistic'
        activateRewards: false,
        optimizeTime: false,
        premiumBudget: 0
    };
    const { mode, activateRewards, optimizeTime, premiumBudget } = executionConfig;
    let remainingPremiumBudget = premiumBudget;

    if (buildOrder.length === 0) {
        console.warn("Nenhuma ordem de construção foi salva. Configure a ordem primeiro!");
        return;
    }

    console.log(`Modo de execução: ${mode}`);
    console.log(`Recompensas automáticas: ${activateRewards ? "Ativadas" : "Desativadas"}`);
    console.log(`Otimização de tempo: ${optimizeTime ? "Ativada" : "Desativada"}`);
    console.log(`Orçamento máximo de Pontos Premium: ${premiumBudget}`);
    console.log(`Milestone atual: ${villageState.currentMilestone}`);
    console.log(`Targets bloqueados: ${villageState.blockedTargets.length}`);

    setupPageObserver(); // Configura o observador de alterações no DOM

    // Loop principal de automação
    while (buildOrder.length > 0) {
        // Recarrega estado a cada iteração
        villageState = loadVillageState();
        
        // Verifica actionLock (previne ações concorrentes)
        if (villageState.actionLock) {
            console.log('Ação bloqueada por outro processo, aguardando...');
            await wait(5000);
            continue;
        }
        
        // Verifica cooldown
        if (isInCooldown()) {
            const waitTime = villageState.cooldownUntil - Date.now();
            if (waitTime > 0) {
                console.log(`Em cooldown, aguardando ${Math.ceil(waitTime/1000)}s...`);
                await wait(Math.min(waitTime, 120000));
                continue;
            }
        }

        if (activateRewards) {
            await collectRewards(); // Coleta recompensas, se ativado
        }

        // **Lógica para Modo SEGUIR A ORDEM**
        if (mode === "followOrder") {
            const { id, level } = buildOrder[0]; // Tenta apenas o primeiro item
            
            // Verifica se target está bloqueado
            if (isTargetBlocked(id, level)) {
                console.warn(`Target ${id} nível ${level} está bloqueado. Pulando...`);
                // Se estiver em followOrder e o primeiro estiver bloqueado, para
                break;
            }
            
            const canBuild = await tryToBuild(id, level);
            if (canBuild) {
                registerSuccess(id, level);
                buildOrder.shift(); // Remove o item construído
            } else {
                registerFailure(id, level, 'nao_foi_possivel_construir');
                console.log(`Modo "Seguir a Ordem": Construção pausada, aguardando ${id} nível ${level}`);
                break; // Se o edifício não puder ser construído, interrompe o loop
            }
        }

        // **Lógica para Modo CONSTRUÇÃO OPORTUNA**
        if (mode === "opportunistic") {
            let builtAtLeastOne = false;
            for (let i = 0; i < buildOrder.length; i++) {
                const { id, level } = buildOrder[i];
                
                // Pula targets bloqueados
                if (isTargetBlocked(id, level)) {
                    console.log(`Pulando target bloqueado: ${id} nível ${level}`);
                    continue;
                }
                
                const canBuild = await tryToBuild(id, level);
                if (canBuild) {
                    registerSuccess(id, level);
                    buildOrder.splice(i, 1); // Remove o edifício construído
                    builtAtLeastOne = true;
                    break; // Após uma construção bem-sucedida, interrompe o loop
                } else {
                    registerFailure(id, level, 'nao_foi_possivel_construir');
                }
            }
            if (!builtAtLeastOne) {
                console.log("Modo 'Construção Oportuna': Nenhum edifício disponível para construção.");
                break;
            }
        }

        // Aguarda a página ser atualizada antes de continuar
        while (!pageUpdated) {
            await wait(1000);
        }
        pageUpdated = false;
        
        // Pequena pausa entre construções para evitar sobrecarga
        await wait(2000);
    }

    console.log("Construção automática concluída!");

    // Desconecta o observador
    if (observer) {
        observer.disconnect();
    }
    hasExecutedBuildOrder = true;
    
    // Salva estado final
    saveVillageState(loadVillageState());
}

/**
 * Tenta construir um edifício específico.
 * @param {string} id - Identificador do edifício.
 * @param {number} level - Nível do edifício desejado.
 * @returns {boolean} - Retorna true se a construção foi bem-sucedida.
 */
async function tryToBuild(id, level) {
    // Adquire lock de ação
    if (!tryAcquireActionLock()) {
        console.warn('Não foi possível adquirir actionLock para construção');
        return false;
    }

    try {
        const buildingName = getBuildingName(id.charAt(0).toUpperCase() + id.slice(1));

        // Verifica se o edifício já está completo
        const buildingStatus = document.querySelector(`.building-row[data-building="${id}"]`);
        if (buildingStatus && buildingStatus.innerText.includes("Edifício totalmente construído")) {
            console.log(`${buildingName} já está totalmente construído.`);
            releaseActionLock();
            return false;
        }

        // Corrige o seletor para argila, pois usa "stone" no DOM
        let dataBuildingSelector = id === "clay" ? "stone" : id;
        const buildButton = document.querySelector(`a.btn-build[data-building="${dataBuildingSelector}"][data-level-next="${level}"]`);

        // Se encontrar o botão, tenta construir
        if (buildButton) {
            console.log(`Construindo: ${buildingName}, Nível: ${level}`);
            
            // Identifica gargalo antes de construir (opcional, para logging)
            const resources = {
                madeira: parseInt(document.querySelector('.wood')?.textContent?.replace(/\./g, '') || '0', 10),
                argila: parseInt(document.querySelector('.stone')?.textContent?.replace(/\./g, '') || '0', 10),
                ferro: parseInt(document.querySelector('.iron')?.textContent?.replace(/\./g, '') || '0', 10)
            };
            
            // Custos aproximados (poderiam ser obtidos do tooltip do botão)
            const costs = { wood: 0, clay: 0, iron: 0 }; // Placeholder
            identifyBottleneck(resources, costs);
            
            buildButton.click();
            await wait(2000); // Espera 2 segundos para o clique ser processado
            await checkAndClickFinish();
            
            // Nota: O sucesso real será confirmado pelo observer e registrado em executeBuildOrder
            releaseActionLock();
            return true;
        } else {
            console.warn(`Não foi possível construir ${buildingName} (Nível ${level}). Botão não encontrado.`);
            releaseActionLock();
            return false;
        }
    } catch (error) {
        console.error(`Erro durante tentativa de construção de ${id} nível ${level}:`, error);
        releaseActionLock();
        return false;
    }
}

// Evento para iniciar a automação ao carregar a página
window.addEventListener('load', () => {
    const villagePagePattern = /https:\/\/br131\.tribalwars\.com\.br\/game\.php\?village=\d+&screen=main/;
    if (villagePagePattern.test(window.location.href) && isBuildAutomationActive) {
        console.log("Automação ativada e executando...");
        executeBuildOrder();
    }
});
























// Função para verificar e exibir o status da opção "Reduzir automaticamente o tempo crítico de construção"
function checkAutoTimeReductionStatus() {
    const recruitmentConfig = JSON.parse(localStorage.getItem('recruitmentConfig')) || {};
    const executionConfig = recruitmentConfig.execution || {};
    const autoTimeReductionEnabled = executionConfig.optimizeTime === true;

    console.log("Reduzir automaticamente o tempo crítico de construção:", autoTimeReductionEnabled ? "Ativado" : "Desativado");
    return autoTimeReductionEnabled;
}

// Evento para inicializar a automação ao carregar a página
document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM completamente carregado. Inicializando automação de construção...");
    initializeBuildAutomation(); // Inicializa o estado da automação
});


/**
 * Obtém o orçamento de Pontos Premium do localStorage.
 * @returns {number} O orçamento de Pontos Premium.
 */
function getPremiumBudget() {
  const recruitmentConfig = JSON.parse(localStorage.getItem('recruitmentConfig')) || {};
  const executionConfig = recruitmentConfig.execution || {};
  return executionConfig.premiumBudget || 0;
}

/**
 * Atualiza o orçamento de Pontos Premium no localStorage e na interface do usuário.
 * @param {number} newBudget - O novo valor do orçamento de Pontos Premium.
 */
function updatePremiumBudget(newBudget) {
  const recruitmentConfig = JSON.parse(localStorage.getItem('recruitmentConfig')) || {};
  recruitmentConfig.execution = recruitmentConfig.execution || {};
  recruitmentConfig.execution.premiumBudget = newBudget;
  localStorage.setItem('recruitmentConfig', JSON.stringify(recruitmentConfig));

  // Atualiza a interface do usuário, se houver um elemento exibindo o orçamento
  const premiumBudgetDisplay = document.getElementById('premium-budget-display'); // Certifique-se de que este ID existe na sua página
  if (premiumBudgetDisplay) {
    premiumBudgetDisplay.textContent = `Orçamento Máximo de Pontos Premium: ${newBudget}`;
  }
}

/**
 * Aplica a redução de tempo de 50% até que o orçamento seja menor que 10.
 */
function apply50PercentTimeReduction() {
    const autoTimeReductionEnabled = checkAutoTimeReductionStatus();
    if (!autoTimeReductionEnabled) {
        console.log("Redução automática de tempo desativada.");
        return;
    }

    let premiumBudget = getPremiumBudget();
    const buttons = document.querySelectorAll('.order_feature.btn.btn-btr');
    const clickedButtons = [];

    for (let i = 0; i < buttons.length; i++) {
        const button = buttons[i];
        const buttonId = button.getAttribute('onclick');

        if (!clickedButtons.includes(buttonId) && button.dataset.availableTo > Date.now() / 1000 && premiumBudget >= 10) {
            try {
                console.log("Clicando no botão -50%...");
                button.click();
                premiumBudget -= 10;
                updatePremiumBudget(premiumBudget);
                clickedButtons.push(buttonId);
            } catch (error) {
                console.error("Erro ao clicar no botão -50%:", error);
            }
        }
    }
}

// Chama a função para aplicar a redução de tempo
apply50PercentTimeReduction();






// Função para verificar e clicar no botão "Finalizar"
async function checkAndClickFinish() {
    console.log("Procurando botão 'Finalizar'...");


    // Localiza o botão "Finalizar" no HTML
    const finishButton = document.querySelector('a.btn-instant-free'); // Altere o seletor, se necessário


    if (finishButton && finishButton.innerText.trim() === "Finalizar") {
        const availableFrom = parseInt(finishButton.getAttribute('data-available-from'), 10); // Tempo disponível
        const currentTime = Math.floor(Date.now() / 1000); // Timestamp atual


        // Verifica se o botão está disponível para clique
        if (currentTime >= availableFrom) {
            console.log("Botão 'Finalizar' disponível. Clicando...");
            finishButton.click(); // Clica no botão "Finalizar"
            await wait(1000); // Aguarda 1 segundo antes de prosseguir
        } else {
            console.log("Botão 'Finalizar' ainda não está disponível.");
        }
    } else {
        console.log("Nenhum botão 'Finalizar' disponível no momento.");
    }
}




























































// Função para adicionar eventos de drag and drop
function addDragAndDropEvents() {
    const container = document.getElementById('construction-orders-container');


    // Configura o SortableJS
    new Sortable(container, {
        animation: 150, // Duração da animação em milissegundos
        ghostClass: 'sortable-ghost', // Classe visual durante o arrasto
        onEnd: () => {
            // Captura a nova ordem dos elementos após o arraste
            const currentOrder = [...container.querySelectorAll('.draggable-card')].map(card => ({
                id: card.dataset.id,
                level: parseInt(card.dataset.level, 10)
            }));


            // Array para armazenar a ordem final reorganizada
            const sortedOrder = [];
            const levelsByBuilding = {};


            // Agrupa os níveis por edifício
            currentOrder.forEach(({ id, level }) => {
                if (!levelsByBuilding[id]) levelsByBuilding[id] = [];
                levelsByBuilding[id].push(level);
            });


            // Ordena os níveis dentro de cada edifício
            Object.keys(levelsByBuilding).forEach(id => {
                levelsByBuilding[id].sort((a, b) => a - b);
            });


            // Reconstrói a ordem final respeitando a posição relativa dos edifícios
            currentOrder.forEach(({ id }) => {
                if (levelsByBuilding[id]?.length > 0) {
                    const level = levelsByBuilding[id].shift(); // Retira o menor nível disponível
                    sortedOrder.push({ id, level });
                }
            });


            // Atualiza a configuração global com a nova ordem
            recruitmentConfig.order = sortedOrder;


            // Atualiza o DOM para refletir a nova ordem com os ícones e nomes traduzidos
            container.innerHTML = sortedOrder
                .map(({ id, level }) => {
                    const buildingIcon = getBuildingIcon(id); // Busca o ícone correspondente
                    const buildingName = getBuildingName(id.charAt(0).toUpperCase() + id.slice(1)); // Busca o nome no idioma correto


                    return `
                        <div class="draggable-card" data-id="${id}" data-level="${level}"
                            style="border: 1px solid #bdc3c7; border-radius: 5px; padding: 8px; background: white; box-shadow: 0px 2px 4px rgba(0, 0, 0, 0.1); display: flex; flex-direction: column; align-items: center; text-align: center; font-size: 12px;">
                            <div style="font-size: 24px; margin-bottom: 4px;">${buildingIcon}</div>
                            <div style="font-size: 14px; font-weight: bold; color: #34495e;">${buildingName}</div>
                            <div style="font-size: 12px; color: #7f8c8d;">Nível ${level}</div>
                        </div>
                    `;
                })
                .join('');


            // Salva no localStorage ou sistema de persistência
            saveRecruitmentConfig();
        }
    });
}


// Função auxiliar para determinar a posição onde o item será inserido
function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('.draggable-card:not(.dragging)')];


    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - (box.top + box.height / 2); // Calcula a distância do centro do elemento
        if (offset < 0 && offset > closest.offset) {
            return { offset, element: child };
        } else {
            return closest;
        }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}


// Função para salvar a nova ordem
function saveOrder() {
    const container = document.getElementById('construction-orders-container');


    // Captura a nova ordem dos cards
    const newOrder = [...container.querySelectorAll('.draggable-card')].map(card => ({
        id: card.dataset.id,
        level: parseInt(card.dataset.level, 10),
    }));


    // Atualiza a configuração global com a nova ordem
    recruitmentConfig.order = newOrder;


    // Atualiza os níveis máximos para cada edifício
    const levels = {};
    newOrder.forEach(({ id, level }) => {
        if (!levels[id]) levels[id] = []; // Inicializa o array para os níveis do edifício
        levels[id].push(level); // Adiciona o nível na ordem certa
    });


    recruitmentConfig.levels = levels;


    // Salva no localStorage ou sistema de persistência
    saveRecruitmentConfig();


    alert("Ordem de construção salva com sucesso!");
}


// Obtém os níveis salvos e a ordem atual de construção
function syncLevelsToOrder() {
    const savedLevels = recruitmentConfig.levels || {};
    const currentOrder = recruitmentConfig.order || [];
    const newOrder = [...currentOrder]; // Copia a ordem atual


    // Adiciona os novos níveis que não estão na ordem atual
    Object.entries(savedLevels).forEach(([id, maxLevel]) => {
        const existingLevels = currentOrder
            .filter(order => order.id === id)
            .map(order => order.level);


        for (let level = 1; level <= maxLevel; level++) {
            if (!existingLevels.includes(level)) {
                newOrder.push({ id, level }); // Adiciona somente níveis não existentes
            }
        }
    });


    recruitmentConfig.order = newOrder; // Atualiza a ordem global
}




// Filtra a ordem para remover o item específico
  function deleteCard(id, level) {
    // Filtra a ordem para remover o item específico
    recruitmentConfig.order = recruitmentConfig.order.filter(order => {
        return !(order.id === id && order.level === parseInt(level, 10));
    });


    // Atualiza os níveis globais
    const levels = recruitmentConfig.order.reduce((acc, { id, level }) => {
        if (!acc[id]) acc[id] = [];
        acc[id].push(level);
        return acc;
    }, {});


    // Atualiza a estrutura de níveis
    recruitmentConfig.levels = Object.fromEntries(
        Object.entries(levels).map(([id, levelsArray]) => [id, Math.max(...levelsArray)])
    );


    // Salva no localStorage ou sistema de persistência
    saveRecruitmentConfig();


    // Atualiza a interface
    openConstructionOrdersPopup();
}


// Função auxiliar para obter ícones dos edifícios
function getBuildingIcon(buildingName) {
    const icons = {
        Main: "🏛️",
        Statue: "🗿",
        Wood: "🌲",
        Clay: "🏺",
        Iron: "⛓️",
        Farm: "🌾",
        Storage: "📦",
        Hide: "🏚️",
        Barracks: "🛡️",
        Stable: "🐎",
        Workshop: "🔧",
        Watchtower: "🔭",
        Academy: "🎓",
        Smith: "⚒️",
        Market: "💰",
        Wall: "🏰"
    };
    return icons[buildingName] || "🏗️";
}







// Adiciona o evento para o botão "Ver Configurações"
document.body.addEventListener('click', (event) => {
    if (event.target.id === 'btn-construction-orders') {
        openConstructionOrdersPopup(); // Mantém o comportamento atual
    }
    if (event.target.id === 'btn-add-order-by-text') {
        openAddOrderByTextPopup(); // Mantém o comportamento atual
    }
    if (event.target.id === 'btn-execution-config') {
        openExecutionConfigPopup(); // Abre o popup de execução
    }
});




// Salva as configurações de níveis desejados
function saveBuildingConfig() {
    const formElements = document.querySelectorAll('#building-config-form input[type="number"]');
    const newLevels = {};


    formElements.forEach(input => {
        const buildingId = input.id.replace('level-', ''); // Extrai o ID do edifício
        const level = parseInt(input.value, 10) || 0; // Obtém o valor ou 0 se inválido
        if (level > 0) {
            newLevels[buildingId] = level;
        }
    });


    // Atualiza os níveis globais mantendo os já existentes
    recruitmentConfig.levels = {
        ...recruitmentConfig.levels, // Níveis existentes
        ...newLevels // Novos níveis configurados
    };


    // Sincroniza e adiciona os novos níveis à ordem
    syncLevelsToOrder();


    // Salva no localStorage ou sistema de persistência
    saveRecruitmentConfig();


    alert("Configurações de níveis salvas e atualizadas com sucesso!");
}




console.log(recruitmentConfig.levels);












































































// Função para criar linhas de tropas organizadas
function createRecruitmentRows(troops) {
    return troops.map(({ id, name, icon }) => `
        <div style="background: white; border: 1px solid #ddd; border-radius: 8px; padding: 4px; text-align: center; box-shadow: 0px 1px 3px rgba(0, 0, 0, 0.1); font-size: 11px;">
            <div style="font-size: 18px; margin-bottom: 4px;">${icon}</div>
            <h4 style="font-size: 12px; color: #333; margin: 0;">${name}</h4>
            <div style="margin-top: 5px;">
                <label for="daily-${id}" style="font-size: 10px; color: #555;">Meta Diária</label>
                <input type="number" id="daily-${id}" name="daily-${id}" value="${recruitmentConfig[`daily${id[0].toUpperCase() + id.slice(1)}`] || 0}" style="width: 95%; margin: 3px 0; padding: 3px; border: 1px solid #ccc; border-radius: 4px; font-size: 10px;">
            </div>
            <div>
                <label for="total-${id}" style="font-size: 10px; color: #555;">Meta Geral</label>
                <input type="number" id="total-${id}" name="total-${id}" value="${recruitmentConfig[`total${id[0].toUpperCase() + id.slice(1)}`] || 0}" style="width: 95%; padding: 3px; border: 1px solid #ccc; border-radius: 4px; font-size: 10px;">
            </div>
        </div>
    `).join('');
}


// Função para salvar as configurações de recrutamento
function saveRecruitmentSettings(event) {
    event.preventDefault(); // Impede o envio do formulário


    // Atualiza os valores no objeto recruitmentConfig
    const troopTypes = ['spear', 'sword', 'axe', 'archer', 'scout', 'light', 'marcher', 'heavy', 'ram', 'catapult'];
    troopTypes.forEach(troop => {
        const dailyValue = parseInt(document.getElementById(`daily-${troop}`).value) || 0;
        const totalValue = parseInt(document.getElementById(`total-${troop}`).value) || 0;


        recruitmentConfig[`daily${troop[0].toUpperCase() + troop.slice(1)}`] = dailyValue;
        recruitmentConfig[`total${troop[0].toUpperCase() + troop.slice(1)}`] = totalValue;
    });


    // Salva no localStorage
    saveRecruitmentConfig();


    // Exibe a mensagem de sucesso
    const messageElement = document.getElementById('success-message');
    messageElement.style.display = 'block';
    setTimeout(() => {
        messageElement.style.display = 'none';
    }, 3000); // Mensagem desaparece após 3 segundos
}


/*// Salva o objeto recruitmentConfig no localStorage
function saveRecruitmentConfig() {
    localStorage.setItem('recruitmentConfig', JSON.stringify(recruitmentConfig));
}*/



/*
// Fecha o pop-up
function closePopup() {
    const popup = document.getElementById('custom-popup');
    if (popup) popup.remove();
}*/






// Função genérica para recrutar tropas (corrigida)
function recruitTroops(unitType, dailyGoalKey, totalGoalKey, recruitAmount, unitId) {
    const dailyGoal = recruitmentConfig[dailyGoalKey] || 0;
    const totalGoal = recruitmentConfig[totalGoalKey] || 0;

    const inputField = document.getElementById(unitId); // Corrigido para usar o ID
    const maxUnitsElement = document.getElementById(`${unitId}_a`);
    const recruitButton = inputField.closest('form').querySelector('input.btn.btn-recruit');

    if (!inputField || !maxUnitsElement || !recruitButton) {
        console.warn(`Elemento não encontrado para: ${unitType}`);
        return;
    }

    const maxUnits = parseInt(maxUnitsElement.textContent.replace(/\D/g, ''), 10) || 0;

    if (totalGoal <= 0 || dailyGoal <= 0) {
        console.log(`Meta atingida para ${unitType}. Nenhum recrutamento realizado.`);
        return;
    }

    // Cálculo da quantidade a recrutar
    const recruitValue = Math.min(recruitAmount, maxUnits, dailyGoal, totalGoal);

    if (recruitValue > 0) {
        inputField.value = recruitValue;
        recruitmentConfig[dailyGoalKey] -= recruitValue;
        recruitmentConfig[totalGoalKey] -= recruitValue;
        saveRecruitmentConfig();
        recruitButton.click();
    } else {
        console.log(`Não há unidades suficientes para recrutar ${unitType}.`);
    }
}

// Atualizando as chamadas das funções específicas com o ID correto
function recruitSpearmen() {
    recruitTroops('Lanceiros', 'dailySpear', 'totalSpear', 20, 'spear_0');
}

function recruitSwordsmen() {
    recruitTroops('Espadachins', 'dailySword', 'totalSword', 20, 'sword_0');
}

function recruitLightCavalry() {
    recruitTroops('Cavalaria Leve', 'dailyLight', 'totalLight', 5, 'light_0');
}

function recruitScouts() {
    recruitTroops('Exploradores', 'dailyScout', 'totalScout', 10, 'spy_0');
}

// Automação periódica corrigida
function startRecruitmentAutomation() {
    setInterval(() => {
        recruitSpearmen();
        recruitSwordsmen();
        recruitLightCavalry();
        recruitScouts();
    }, 5000);
}

// Iniciar automação corrigida
startRecruitmentAutomation();








// Lógica para salvar os valores configurados
document.body.addEventListener('click', (event) => {
    if (event.target.id === 'save-recruitment-config') {
        recruitmentConfig.dailySpear = parseInt(document.getElementById('daily-spear').value) || 0;
        recruitmentConfig.dailySword = parseInt(document.getElementById('daily-sword').value) || 0;
        recruitmentConfig.dailyAxe = parseInt(document.getElementById('daily-axe').value) || 0;
        recruitmentConfig.dailyLight = parseInt(document.getElementById('daily-light').value) || 0;


        recruitmentConfig.totalSpear = parseInt(document.getElementById('total-spear').value) || 0;
        recruitmentConfig.totalSword = parseInt(document.getElementById('total-sword').value) || 0;
        recruitmentConfig.totalAxe = parseInt(document.getElementById('total-axe').value) || 0;
        recruitmentConfig.totalLight = parseInt(document.getElementById('total-light').value) || 0;


        recruitmentConfig.autoDistribute = document.getElementById('auto-distribute').checked;


        // Salva no localStorage
        saveRecruitmentConfig();
        createPopup('<p style="font-weight: bold; font-size: 16px; color: #28a745;">Configurações salvas com sucesso!</p>');
        setTimeout(closePopup, 2000);
    }
});








    // Salva configurações de recrutamento
    document.body.addEventListener('click', (event) => {
        if (event.target.id === 'save-recruitment-config') {
            recruitmentConfig.spear = parseInt(document.getElementById('spear').value) || 0;
            recruitmentConfig.sword = parseInt(document.getElementById('sword').value) || 0;
            recruitmentConfig.axe = parseInt(document.getElementById('axe').value) || 0;
            recruitmentConfig.light = parseInt(document.getElementById('light').value) || 0;
            saveRecruitmentConfig();
            createPopup('<p style="font-weight: bold; font-size: 16px; color: #28a745;">Configuração salva com sucesso!</p>');
            setTimeout(closePopup, 2000);
        }
    });


    // Evento para abrir configuração de recrutamento
    document.body.addEventListener('click', (event) => {
        if (event.target.classList.contains('configure-recruitment')) {
            showRecruitmentConfig();
        }
    });


    // Evento para salvar funções selecionadas
    document.body.addEventListener('click', (event) => {
        if (event.target.id === 'save-functions') {
            const selectedFunctions = Array.from(document.querySelectorAll('#function-form input:checked')).map(input => input.value);
            activeFunctions = selectedFunctions;
            saveActiveFunctions();
            createPopup('<p style="font-weight: bold; font-size: 16px; color: #28a745;">Funções salvas com sucesso!</p>');
            setTimeout(closePopup, 2000);
        }
    });


    // Evento para fechar pop-up
    document.body.addEventListener('click', (event) => {
        if (event.target.id === 'close-popup') {
            closePopup();
        }
    });


    // Configura o evento de duplo clique direito
let rightClickCount = 0;
document.addEventListener('contextmenu', (event) => { // Use 'contextmenu' para clique direito
    event.preventDefault(); // Impede o menu de contexto padrão do navegador
    rightClickCount++;
    setTimeout(() => rightClickCount = 0, 500); // Reset após 500ms
    if (rightClickCount === 2) {
        showFunctionSelector();
    }
});



    // Carrega dados ao iniciar o script
    loadActiveFunctions();
    loadRecruitmentConfig();
    startAutoRedirect();
})();






// Constants and Configuration
const CONFIG = {
  SKIP_WALL: true,
  RELOAD_INTERVAL: { MIN: 2222000, MAX: 2222000 },
  ATTACK_INTERVAL: 800,
  WAIT_TIME: { MIN: 15000, MAX: 30000 }
};

// Utility functions
const delay = ms => new Promise(res => setTimeout(res, ms));
const randomTime = (min, max) => Math.round(min + Math.random() * (max - min));

// Main Script Execution
(function() {
  'use strict';

  // Check for required dependencies
  if (typeof Accountmanager === 'undefined' || typeof Accountmanager.farm === 'undefined') {
    console.error('Accountmanager or farm not defined');
    return;
  }

  class SmartFarm {
    constructor() {
      this.TemplatesEnum = {
        A: 'a',
        B: 'b',
      };
    }

    getTemplates() {
      return Accountmanager.farm.templates;
    }

    getCurrentUnits() {
      return Accountmanager.farm.current_units;
    }

    getNextVillage() {
      return document.querySelector("tr[id^='village_']:not([style='display: none;'])");
    }

    hasLootedAll(villageElement) {
      const lastLoot = villageElement.querySelector("img[src*='max_loot']");
      return lastLoot && lastLoot.getAttribute("src").endsWith("1.png");
    }

    hasEnoughUnitsInTemplate(template) {
      const units = this.getCurrentUnits();
      return Object.entries(units).every(([unitName, unitQuantity]) => {
        return !template[unitName] || unitQuantity >= template[unitName];
      });
    }

    getWallLevel(villageElement) {
      return villageElement.querySelectorAll("td")[6].innerHTML;
    }

    validateAndHideWall(villageElement) {
      const wallLevel = this.getWallLevel(villageElement);
      if (wallLevel !== '?' && parseInt(wallLevel, 10) > 1) {
        villageElement.style.display = 'none';
        return true;
      }
      return false;
    }

    clickTemplate(templateType, villageElement) {
      const selector = `a.farm_icon.farm_icon_${templateType}`;
      const templateLink = villageElement.querySelector(selector);
      templateLink?.click();
    }

    validateAndSendTemplate(template, villageElement, templateType) {
      if (this.hasEnoughUnitsInTemplate(template)) {
        this.clickTemplate(templateType, villageElement);
        return true;
      }
      return false;
    }

    reloadPage() {
      const reloadTime = randomTime(CONFIG.RELOAD_INTERVAL.MIN, CONFIG.RELOAD_INTERVAL.MAX);
      console.log(`will reload in ${reloadTime / 1000} seconds`);
      setTimeout(() => {
        console.log("reloading...");
        window.location.reload();
      }, reloadTime);
    }

    async sendAttack() {
      const templates = this.getTemplates();
      if (!templates) return;

      const [templateA, templateB] = Object.values(templates);
      const villageElement = this.getNextVillage();

      if (villageElement) {
        if (CONFIG.SKIP_WALL && this.validateAndHideWall(villageElement)) return;

        if (this.hasLootedAll(villageElement)) {
          if (!this.validateAndSendTemplate(templateB, villageElement, this.TemplatesEnum.B)) {
            this.validateAndSendTemplate(templateA, villageElement, this.TemplatesEnum.A);
          }
        } else {
          this.validateAndSendTemplate(templateA, villageElement, this.TemplatesEnum.A);
        }

        await delay(randomTime(CONFIG.WAIT_TIME.MIN, CONFIG.WAIT_TIME.MAX));
      }
    }

    async init() {
      console.log("starting farm");
      this.reloadPage();
      setInterval(() => this.sendAttack(), CONFIG.ATTACK_INTERVAL);
    }
  }

  new SmartFarm().init();
})();















(function() {
    'use strict';

    const ScriptData = {
        name: "Auto notes from report",
        version: "v2.5",
        lastUpdate: "2024-05-16",
        author: "xdam98",
        authorContact: "Xico#7941 (Discord)"
    };

    const LS_prefix = "xd";
    const translations = {
        pt_BR: {
            unknown: "Desconhecido",
            verifyReportPage: "O Script deve ser utilizado dentro de um relatório ofensivo ou defensivo!",
            offensive: "Ofensiva",
            defensive: "Defensiva",
            probOffensive: "Provavelmente Ofensiva",
            probDefensive: "Provavelmente Defensiva",
            noSurvivors: "Nenhuma tropa sobreviveu",
            watchtower: "Torre ",
            wall: "Muralha ",
            firstChurch: "Igreja Principal",
            church: "Igreja",
            defensiveNukes: " fulls defesa",
            noteCreated: "Nota criada",
            addReportTo: "Colocar relatório no:",
            attacker: "Atacante",
            defender: "Defensor"
        },
        en_DK: {
            unknown: "Unknown",
            verifyReportPage: "This script can only be run on a report screen.",
            offensive: "Offensive",
            defensive: "Defensive",
            probOffensive: "Probably Offensive",
            probDefensive: "Probably Defensive",
            noSurvivors: "No troops survived",
            watchtower: "Watchtower",
            wall: "Wall",
            firstChurch: "First church",
            church: "Church",
            defensiveNukes: "deffensive nukes",
            noteCreated: "Note created",
            addReportTo: "Add report to which village:",
            attacker: "Attacker",
            defender: "Defender"
        }
    };

    const _t = a => translations[game_data.locale]?.[a] || translations.pt_BR[a];
    const initTranslations = () => localStorage.getItem(`${LS_prefix}_langWarning`) ? 1 : (void 0 === translations[game_data.locale] && UI.ErrorMessage(`No translation found for <b>${game_data.locale}</b>.`, 3e3), localStorage.setItem(`${LS_prefix}_langWarning`, 1), 0);

    const defaultSettings = {
        includeWatchtower: true,
        includeWall: true,
        includeChurch: true,
        includeDefensiveNukes: true,
        markOffensiveColor: "#ff0000",
        markDefensiveColor: "#0eae0e",
        minOffensiveTroops: 3000,
        minProbOffensiveTroops: 500,
        minDefensiveTroops: 1000,
        minProbDefensiveTroops: 500,
        useCombinedTroopsForType: true,
    };

    let settings = { ...defaultSettings };

    const loadSettings = () => {
        try {
            const storedSettings = localStorage.getItem(`${LS_prefix}_settings`);
            if (storedSettings) {
                settings = { ...defaultSettings, ...JSON.parse(storedSettings) };
            }
        } catch (e) {
            console.error("Error loading settings:", e);
        }
    };

    const saveSettings = () => {
        try {
            localStorage.setItem(`${LS_prefix}_settings`, JSON.stringify(settings));
        } catch (e) {
            console.error("Error saving settings:", e);
        }
    };

    // Objeto principal do script
    const CriarRelatorioNotas = {
        dados: {
            player: {
                nomePlayer: game_data.player.name,
                playerEstaAtacar: false,
                playerEstaDefender: false,
                playerQuerInfoAtacante: false,
                playerQuerInfoDefensor: false
            },
            aldeia: {
                ofensiva: {
                    idAldeia: "-1",
                    tipoAldeia: _t("unknown"),
                    tropas: {
                        totais: [],
                        ofensivas: 0,
                        defensivas: 0
                    }
                },
                defensiva: {
                    idAldeia: "-1",
                    tipoAldeia: _t("unknown"),
                    tropas: {
                        visiveis: false,
                        totais: [],
                        fora: {
                            visiveis: false,
                            ofensivas: 0,
                            defensivas: 0,
                            totais: []
                        },
                        dentro: {
                            ofensivas: 0,
                            defensivas: 0,
                            totais: []
                        },
                        apoios: 0
                    },
                    edificios: {
                        edificiosVisiveis: false,
                        torre: [false, 0],
                        igrejaPrincipal: [false, 0],
                        igreja: [false, 0],
                        muralha: [false, 0]
                    }
                }
            },
            mundo: {
                fazendaPorTropa: [],
                arqueirosAtivos: false
            }
        },
        // Verifica se o script está sendo executado na página correta (relatório)
        verificarPagina: function() {
            const url = window.location.href;
            return url.includes("screen=report") && url.includes("&mode=all&group_id=-1&view=");
        },
        // Inicializa os dados do script, extraindo informações da página
        initDadosScript: function() {
            this.dados.mundo.arqueirosAtivos = game_data.units.includes("archer");
            const numUnits = this.dados.mundo.arqueirosAtivos ? 10 : 8;
            this.dados.aldeia.defensiva.tropas.totais = new Array(numUnits).fill(0);
            this.dados.aldeia.defensiva.tropas.fora.totais = new Array(numUnits).fill(0);
            this.dados.aldeia.defensiva.tropas.dentro.totais = new Array(numUnits).fill(0);
            this.dados.mundo.fazendaPorTropa = this.dados.mundo.arqueirosAtivos ? [1, 1, 1, 1, 2, 4, 5, 6, 5, 8] : [1, 1, 1, 2, 4, 6, 5, 8];

            const nomeAtacante = $("#attack_info_att > tbody > tr:nth-child(1) > th:nth-child(2) > a").text();
            const nomeDefensor = $("#attack_info_def > tbody > tr:nth-child(1) > th:nth-child(2) > a").text();
            const sitterOffset = game_data.player.sitter !== "0" ? 4 : 3;

            this.dados.aldeia.ofensiva.idAldeia = $("#attack_info_att > tbody > tr:nth-child(2) > td:nth-child(2) > span > a:nth-child(1)").url().split("=")[sitterOffset];
            this.dados.aldeia.defensiva.idAldeia = $("#attack_info_def > tbody > tr:nth-child(2) > td:nth-child(2) > span > a:nth-child(1)").url().split("=")[sitterOffset];

            if (nomeDefensor === this.dados.player.nomePlayer) {
                this.dados.player.playerEstaDefender = true;
            } else if (nomeAtacante === this.dados.player.nomePlayer) {
                this.dados.player.playerEstaAtacar = true;
            }

            if (this.dados.player.playerEstaDefender) {
                this.extrairTropas(
                    "#attack_info_att_units",
                    "tr:nth-child(2)",
                    "td.unit-item",
                    this.dados.aldeia.defensiva.tropas.dentro
                );
            } else if (this.dados.player.playerEstaAtacar) {
                this.extrairTropasFora();
                this.extrairTropas(
                    "#attack_info_def_units",
                    "tr:nth-child(2)",
                    "td.unit-item",
                    this.dados.aldeia.defensiva.tropas.dentro
                );
            }

            this.extrairEdificios();
        },
       extrairTropas: function(seletorTabela, seletorLinha, seletorCelula, tropas) {
    if (!$(seletorTabela).length) return;

    const ignorarPerdasAtacante = this.dados.player.playerEstaAtacar && seletorTabela === "#attack_info_att_units";

    $(seletorTabela + " > tbody > " + seletorLinha).each((_, linha) => {
        $(linha).find(seletorCelula).each((indexCelula, celula) => {
            const quantidade = parseInt(celula.textContent) || 0;

            // Ignora células de tropas perdidas se for atacante
            if (ignorarPerdasAtacante && $(celula).parent().find('td.unit-item').index(celula) % 2 !== 0) {
                return; // Ignora células de perdas
            }

            if (indexCelula < tropas.totais.length) {
                tropas.totais[indexCelula] = quantidade;
            }
            this.calcularTropasOfensivasDefensivas(quantidade, indexCelula, tropas);
        });
    });
},


        extrairTropasFora: function() {
            if ($("#attack_spy_away > tbody > tr:nth-child(1) > th").length) {
                this.dados.aldeia.defensiva.tropas.fora.visiveis = true;
                this.extrairTropas(
                    "#attack_spy_away > tbody > tr:nth-child(2) > td > table > tbody > tr:nth-child(2)",
                    "",
                    "td",
                    this.dados.aldeia.defensiva.tropas.fora
                );
            }
        },
        extrairEdificios: function() {
            if ($("#attack_spy_buildings_left > tbody > tr:nth-child(1) > th:nth-child(1)").length) {
                this.dados.aldeia.defensiva.edificios.edificiosVisiveis = true;
                $("table[id^='attack_spy_buildings_'] > tbody > tr:gt(0) > td > img").each((index, element) => {
                    const edificio = element.src.split("/")[7].replace(".png", "");
                    const nivel = parseInt(element.parentNode.parentNode.childNodes[3].textContent);
                    if (edificio === "watchtower") {
                        this.dados.aldeia.defensiva.edificios.torre = [true, nivel];
                    } else if (edificio === "church_f") {
                        this.dados.aldeia.defensiva.edificios.igrejaPrincipal = [true, nivel];
                    } else if (edificio === "church") {
                        this.dados.aldeia.defensiva.edificios.igreja = [true, nivel];
                    } else if (edificio === "wall") {
                        this.dados.aldeia.defensiva.edificios.muralha = [true, nivel];
                    }
                });
            }
        },
        // Função auxiliar para calcular tropas ofensivas e defensivas
        calcularTropasOfensivasDefensivas: function(quantidade, index, tropas) {
            const isArcherWorld = this.dados.mundo.arqueirosAtivos;
            const offensiveUnits = isArcherWorld ? [2, 5, 6, 8] : [2, 4, 6];
            const defensiveUnits = isArcherWorld ? [4, 7, 9] : [3, 5, 7];

            if (offensiveUnits.includes(index)) {
                tropas.ofensivas += quantidade * this.dados.mundo.fazendaPorTropa[index];
            } else if (defensiveUnits.includes(index)) {
                tropas.defensivas += quantidade * this.dados.mundo.fazendaPorTropa[index];
            }
        },
        // Determina o tipo da aldeia (ofensiva, defensiva, etc.)
        getTipoAldeia: function() {
            const defensiva = this.dados.aldeia.defensiva;
            const ofensiva = this.dados.aldeia.ofensiva;

            const checkTroops = (troops, isOutside = false) => {
                let type = _t("unknown");
                const minOffensive = settings.minOffensiveTroops;
                const minProbOffensive = settings.minProbOffensiveTroops;
                const minDefensive = settings.minDefensiveTroops;
                const minProbDefensive = settings.minProbDefensiveTroops;

                if (troops.ofensivas > minOffensive) {
                    type = _t("offensive");
                } else if (troops.ofensivas > minProbOffensive) {
                    type = _t("probOffensive");
                } else if (troops.defensivas > minDefensive) {
                    type = _t("defensive");
                } else if (troops.defensivas > minProbDefensive) {
                    type = _t("probDefensive");
                } else if (settings.useCombinedTroopsForType && troops.defensivas + troops.ofensivas > minProbDefensive) {
                    if (troops.ofensivas > troops.defensivas) {
                        type = _t("probOffensive");
                    } else if (troops.defensivas >= troops.ofensivas) {
                        type = _t("probDefensive");
                    }
                }
                if (isOutside) {
                    defensiva.tropas.apoios += Math.round(troops.defensivas / 20000 * 10) / 10;
                }
                return type;
            };

            if (defensiva.tropas.visiveis) {
                defensiva.tipoAldeia = checkTroops(defensiva.tropas.dentro);
                defensiva.tropas.apoios = Math.round(defensiva.tropas.dentro.defensivas / 20000 * 10) / 10;
            } else {
                defensiva.tipoAldeia = _t("noSurvivors");
            }

            if (defensiva.tropas.fora.visiveis) {
                const outsideType = checkTroops(defensiva.tropas.fora, true);
                if (defensiva.tipoAldeia === _t("noSurvivors") || defensiva.tipoAldeia === _t("unknown")) {
                    defensiva.tipoAldeia = outsideType;
                }
            }

            if (ofensiva.tropas.ofensivas > ofensiva.tropas.defensivas) {
                ofensiva.tipoAldeia = _t("offensive");
            } else if (ofensiva.tropas.ofensivas < ofensiva.tropas.defensivas) {
                ofensiva.tipoAldeia = _t("defensive");
            }
        },
        // Gera o texto da nota a ser adicionada à aldeia
        geraTextoNota: function() {
    let tipoAldeia,
        codigoRelatorio = $("#report_export_code").text(),
        textoRelatorio = "",
        textoNota = "";

    if (this.dados.player.playerEstaAtacar) {
        tipoAldeia = this.dados.aldeia.defensiva.tipoAldeia;
        const nomeAldeiaInimiga = $("#attack_info_def > tbody > tr:nth-child(1) > th:nth-child(2) > a").text();
        textoRelatorio = nomeAldeiaInimiga;

        // Ignorar perdas do atacante na nota
        textoNota += `[b]${_t("attacker")}:[/b] ${this.dados.aldeia.ofensiva.tipoAldeia}`;
    } else if (this.dados.player.playerEstaDefender) {
        tipoAldeia = this.dados.aldeia.ofensiva.tipoAldeia;
        const nomeAldeiaInimiga = $("#attack_info_att > tbody > tr:nth-child(1) > th:nth-child(2) > a").text();
        textoRelatorio = nomeAldeiaInimiga;
    }

    const color = (tipoAldeia === _t("offensive") || tipoAldeia === _t("probOffensive")) ? settings.markOffensiveColor : settings.markDefensiveColor;
    textoNota += `|[color=${color}][b]${tipoAldeia}[/b][/color]|`;

    if (this.dados.player.playerEstaAtacar) {
        if (settings.includeWatchtower && this.dados.aldeia.defensiva.edificios.torre[0]) {
            textoNota += `[building]watchtower[/building] ${_t("watchtower")}${this.dados.aldeia.defensiva.edificios.torre[1]}|`;
        }
        if (settings.includeWall && this.dados.aldeia.defensiva.edificios.muralha[0]) {
            textoNota += `[building]wall[/building] ${_t("wall")}${this.dados.aldeia.defensiva.edificios.muralha[1]}|`;
        }
        if (settings.includeChurch && this.dados.aldeia.defensiva.edificios.igrejaPrincipal[0]) {
            textoNota += `[building]church_f[/building] ${_t("firstChurch")}|`;
        }
        if (settings.includeChurch && this.dados.aldeia.defensiva.edificios.igreja[0]) {
            textoNota += `[building]church_f[/building] ${_t("church")} ${this.dados.aldeia.defensiva.edificios.igreja[1]}|`;
        }
        if (settings.includeDefensiveNukes && this.dados.aldeia.defensiva.tropas.visiveis && tipoAldeia !== _t("offensive") && tipoAldeia !== _t("probOffensive")) {
            textoNota += `${this.dados.aldeia.defensiva.tropas.apoios}${_t("defensiveNukes")}|`;
        }
    }

    textoNota += "[b][size=6]xD[/size][/b]";
    textoNota += `\n\n[b]${textoRelatorio}[/b]`;
    textoNota += `${codigoRelatorio}`;

    return textoNota;
},

        // Escreve a nota na aldeia
        escreveNota: async function() {
            let nota, aldeiaId;

            if (this.dados.player.playerEstaAtacar || this.dados.player.playerQuerInfoDefensor) {
                aldeiaId = parseInt(this.dados.aldeia.defensiva.idAldeia);
            } else {
                aldeiaId = parseInt(this.dados.aldeia.ofensiva.idAldeia);
            }

            if (this.dados.player.playerEstaAtacar || this.dados.player.playerEstaDefender) {
                nota = this.geraTextoNota();
                await this.saveNote(nota, aldeiaId);
            } else {
                this.showDialog();
            }
        },
        showDialog: function() {
            const dialogContent = $(`<div class="center"> ${_t("addReportTo")} </div>`);
            const buttons = $(`<div class="center"><button class="btn btn-confirm-yes atk">${_t("attacker")}</button><button class="btn btn-confirm-yes def">${_t("defender")}</button></div>`);
            const dialog = dialogContent.add(buttons);

            Dialog.show("relatorio_notas", dialog);

            buttons.find("button.atk").click(async () => {
                this.dados.player.playerQuerInfoAtacante = true;
                const nota = this.geraTextoNota();
                await this.saveNote(nota, this.dados.aldeia.ofensiva.idAldeia);
                Dialog.close();
            });

            buttons.find("button.def").click(async () => {
                this.dados.player.playerQuerInfoDefensor = true;
                const nota = this.geraTextoNota();
                await this.saveNote(nota, this.dados.aldeia.defensiva.idAldeia);
                Dialog.close();
            });
        },
        saveNote: async function(note, villageId) {
            const apiURL = game_data.player.sitter === "0" ?
                `https://${location.hostname}/game.php?village=${game_data.village.id}&screen=api&ajaxaction=village_note_edit&h=${game_data.csrf}&client_time=${Math.round(Timing.getCurrentServerTime() / 1e3)}` :
                `https://${location.hostname}/game.php?village=${game_data.village.id}&screen=api&ajaxaction=village_note_edit&t=${game_data.player.id}`;
            try {
                await $.post(apiURL, {
                    note: note,
                    village_id: villageId,
                    h: game_data.csrf
                });
                UI.SuccessMessage(_t("noteCreated"), 2000);
            } catch (error) {
                console.error("Error saving note:", error);
                UI.ErrorMessage("Error saving note.", 3000);
            }
        },
        // Inicia o script
        start: async function() {
            if (this.verificarPagina()) {
                this.initDadosScript();
                this.getTipoAldeia();
                await this.escreveNota();
            }
        }
    };

    // Inicializa as traduções e inicia o script
    if (initTranslations()) {
        loadSettings();
        CriarRelatorioNotas.start();
    } else {
        setTimeout(async () => {
            loadSettings();
            await CriarRelatorioNotas.start();
        }, 3000);
    }
})();



(function () {
    'use strict';

    // Função que verifica e clica no botão, caso apareça
    function clicarBotaoProtecao() {
        // Seleciona o botão baseado na classe e texto
        const botao = document.querySelector('a.btn.btn-default');

        if (botao && botao.textContent.includes('Iniciar a verificação da proteção do bot')) {
            console.log("Botão encontrado. Clicando...");
            botao.click(); // Clica no botão
        }
    }

    // Executa a verificação a cada 2 segundos
    setInterval(clicarBotaoProtecao, 2000);
})();

