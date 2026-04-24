// ==UserScript==
// @name         Tribal Wars - Smart Automation
// @namespace    http://tampermonkey.net/
// @version      7.0
// @description  Motor de precisão com memória, anti-loop e cooldown por aldeia
// @author       You
// @match        *://*.tribalwars.com.br/*
// @match        *://*.divoke-kmene.sk/*
// @match        *://*.guerrastribales.es/*
// @match        *://*.tribalwars.us/*
// @match        *://*.voynaplemyon.com/*
// @match        *://*.tribalwars.com/*
// @match        *://*.tribalwars.nl/*
// @match        *://*.fyletikesmaxes.gr/*
// @match        *://*.guerretribale.fr/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_log
// @connect      api.groq.com
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

   // ============================================================
    // CONFIG - VERSÃO TURBO (LOOP CONTÍNUO & RUSH GRÁTIS)
    // ============================================================
    var CONFIG = {
        debug: true,
        groqApiKey: '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',
        groqModel: 'llama3-70b-8192',
        autoAssignFlag: true,
        autoRecruitKnight: true,
        autoBuildStatue: true,
        autoRushStatue: true,    // Finaliza estátua com ouro se disponível
        useGroqChecklist: true,
        checklistDelay: 2000,    // Delay inicial reduzido para 2s

        // --- NOVAS CONFIGURAÇÕES DE PERFORMANCE ---
        mainLoopInterval: 20000, // Ciclo padrão: Verifica a aldeia a cada 20 segundos
        freeRushMinutes: 3       // Finaliza construções grátis se faltar menos de 3 minutos
    };
    // ============================================================
    // ESTRATÉGIAS DE CRESCIMENTO (Pesos de 1 a 10)
    // ============================================================
    var STRATEGIES = {
        'BALANCED': { wood: 8, stone: 8, iron: 7, storage: 6, main: 5, farm: 5, barracks: 4, wall: 3, smith: 3, stable: 2 },
        'ECONOMY':  { wood: 10, stone: 10, iron: 9, storage: 7, main: 6, farm: 5, market: 3, wall: 1 },
        'MILITARY': { barracks: 10, stable: 8, smith: 7, farm: 9, iron: 7, wood: 5, stone: 5, wall: 6, main: 5 }
    };




    // ============================================================
    // ROADMAP / MARCOS ESTRATÉGICOS (METAS DO JOGO)
    // ============================================================
    const MILESTONES = [
        { id: 'unlock_statue',   label: 'Erigir Estátua',      reqs: { statue: 1 } },
        { id: 'hq_early',        label: 'Ed. Principal Nv 5',  reqs: { main: 5 } },
        { id: 'unlock_barracks', label: 'Quartel de Tropa',    reqs: { barracks: 1 } },
        { id: 'unlock_smith',    label: 'Caminho do Ferreiro', reqs: { smith: 1 } },
        { id: 'economy_base',    label: 'Base Econômica 10',   reqs: { wood: 10, stone: 10, iron: 8 } },
        { id: 'hq_mid',          label: 'Aceleração HQ Nv 10', reqs: { main: 10 } },
        { id: 'stable_path',     label: 'Desbloqueio Estábulo',reqs: { stable: 1 } },
        { id: 'economy_15',      label: 'Escala Econômica',    reqs: { wood: 15, stone: 15, iron: 15 } },
        { id: 'noble_prep',      label: 'Preparo da Academia', reqs: { main: 20, smith: 20, market: 10 } }
    ];

    var FLAG_TYPE_MAP = {
        1: 'resource', 2: 'recruitment', 3: 'attack',
        4: 'defense', 5: 'luck', 6: 'population', 7: 'coin', 8: 'loot',
    };

    var CATEGORY_PRIORITY = {
        EARLY: { resource: 100, population: 80, recruitment: 60, attack: 50, defense: 40, loot: 30, luck: 20, coin: 10 },
        MID:   { attack: 100, loot: 90, recruitment: 80, resource: 70, population: 60, defense: 50, luck: 40, coin: 30 },
        LATE:  { attack: 100, loot: 95, coin: 80, recruitment: 70, resource: 60, population: 50, defense: 40, luck: 30 },
    };

    // ============================================================
    // CUSTOS DE EDIFÍCIOS (BASE TW 10.x - AJUSTÁVEL POR MUNDO)
    // Formato: [madeira, pedra, ferro, tempo_segundos]
    // ============================================================
    const TW_BUILDING_COSTS = {
        main:    [20, 40, 0, 60],
        barracks:[80, 120, 0, 120],
        church:  [300, 500, 0, 300],
        watchtower:[150, 200, 0, 180],
        stable:  [200, 300, 150, 240],
        garage:  [400, 500, 300, 300],
        snob:    [60000, 60000, 60000, 3600],
        smith:   [100, 150, 50, 150],
        place:   [50, 100, 0, 90],
        statue:  [500, 500, 500, 600],
        market:  [100, 100, 50, 120],
        wood:    [50, 0, 0, 60],
        stone:   [0, 50, 0, 60],
        iron:    [0, 0, 50, 60],
        farm:    [70, 90, 0, 90],
        storage: [100, 100, 0, 90],
        hide:    [150, 0, 100, 150],
        wall:    [100, 150, 0, 180]
    };

    // Fatores de peso estratégico por fase e tipo de edifício
    const STRATEGIC_WEIGHT = {
        EARLY: { wood: 1.2, stone: 1.1, iron: 0.8, farm: 1.3, storage: 1.0, main: 1.5, barracks: 1.0, smith: 1.0, statue: 0.9, market: 0.7, stable: 0.6, wall: 0.8, place: 0.5, hide: 0.4, church: 0.3, watchtower: 0.3, garage: 0.2, snob: 0.1 },
        MID:   { wood: 1.0, stone: 1.0, iron: 1.1, farm: 1.1, storage: 1.0, main: 1.8, barracks: 1.1, smith: 1.2, statue: 1.0, market: 0.9, stable: 1.3, wall: 1.1, place: 0.6, hide: 0.5, church: 0.7, watchtower: 0.6, garage: 0.8, snob: 0.3 },
        LATE:  { wood: 0.8, stone: 0.8, iron: 1.2, farm: 0.9, storage: 0.9, main: 2.0, barracks: 1.0, smith: 1.3, statue: 1.1, market: 1.0, stable: 1.2, wall: 1.3, place: 0.7, hide: 0.6, church: 0.9, watchtower: 0.8, garage: 1.0, snob: 1.5 }
    };
    
    // Bônus do HQ como multiplicador de produtividade (acelera TODAS as construções)
    const HQ_PRODUCTIVITY_BONUS = {
        1: 0.00, 2: 0.02, 3: 0.04, 4: 0.06, 5: 0.08,  // +8% aos 5
        6: 0.10, 7: 0.12, 8: 0.14, 9: 0.16, 10: 0.20, // +20% aos 10 (marco hq_mid)
        11: 0.22, 12: 0.24, 13: 0.26, 14: 0.28, 15: 0.30,
        16: 0.32, 17: 0.34, 18: 0.36, 19: 0.38, 20: 0.40,
        21: 0.42, 22: 0.44, 23: 0.46, 24: 0.48, 25: 0.50  // +50% no máximo
    };

    // Perfis de jogador (configurável via GM_setValue)
    const PLAYER_PROFILES = {
        balanced: { resource: 1.0, military: 1.0, defense: 1.0, expansion: 0.8 },
        raider:   { resource: 0.7, military: 1.5, defense: 0.6, expansion: 1.2 },
        defender: { resource: 0.9, military: 0.8, defense: 1.5, expansion: 0.5 },
        farmer:   { resource: 1.4, military: 0.6, defense: 0.7, expansion: 0.8 },
        noble:    { resource: 1.1, military: 1.2, defense: 0.9, expansion: 1.5 }
    };

    // ============================================================
    // SISTEMA DE MEMÓRIA E ANTI-LOOP POR ALDEIA
    // ============================================================
    var VillageMemory = {
        // Chaves de persistência por villageId
        KEYS: {
            lastTarget: 'village_last_target_',
            lastSuccess: 'village_last_success_',
            lastError: 'village_last_error_',
            cooldownUntil: 'village_cooldown_until_',
            previousBottleneck: 'village_prev_bottleneck_',
            currentMilestone: 'village_current_milestone_',
            consecutiveFails: 'village_consecutive_fails_',
            blockedTargets: 'village_blocked_targets_',
            actionLock: 'village_action_lock_'
        },
        
        // Duração dos cooldowns em ms
        COOLDOWNS: {
            BUILD_FAIL: 300000,      // 5 minutos após falha de construção
            TARGET_BLOCK: 600000,    // 10 minutos para targets problemáticos
            ACTION_LOCK: 3000,       // 3 segundos entre ações
            SOFT_RESET: 1800000      // 30 minutos para reset suave
        },
        
        // Obter memória completa de uma aldeia
        get: function(villageId) {
            return {
                lastTarget: GM_getValue(this.KEYS.lastTarget + villageId, null),
                lastSuccess: GM_getValue(this.KEYS.lastSuccess + villageId, null),
                lastError: GM_getValue(this.KEYS.lastError + villageId, null),
                cooldownUntil: GM_getValue(this.KEYS.cooldownUntil + villageId, 0),
                previousBottleneck: GM_getValue(this.KEYS.previousBottleneck + villageId, null),
                currentMilestone: GM_getValue(this.KEYS.currentMilestone + villageId, null),
                consecutiveFails: GM_getValue(this.KEYS.consecutiveFails + villageId, 0),
                blockedTargets: GM_getValue(this.KEYS.blockedTargets + villageId, {}),
                actionLock: GM_getValue(this.KEYS.actionLock + villageId, false)
            };
        },
        
        // Atualizar campo específico
        set: function(villageId, field, value) {
            var key = this.KEYS[field] + villageId;
            GM_setValue(key, value);
            log('[memória] ' + field + ' = ' + JSON.stringify(value), 'info');
        },
        
        // Registrar ação bem-sucedida
        recordSuccess: function(villageId, target) {
            this.set(villageId, 'lastTarget', target);
            this.set(villageId, 'lastSuccess', Date.now());
            this.set(villageId, 'consecutiveFails', 0);
            this.set(villageId, 'actionLock', false);
            log('[memória] Sucesso: ' + target, 'success');
        },
        
        // Registrar falha
        recordError: function(villageId, target, errorType) {
            var mem = this.get(villageId);
            var fails = (mem.consecutiveFails || 0) + 1;
            
            this.set(villageId, 'lastError', { target: target, type: errorType, time: Date.now() });
            this.set(villageId, 'consecutiveFails', fails);
            this.set(villageId, 'cooldownUntil', Date.now() + this.COOLDOWNS.BUILD_FAIL);
            this.set(villageId, 'actionLock', false);
            
            // Bloquear target problemático se falhas consecutivas >= 2
            if (fails >= 2 && target) {
                this.blockTarget(villageId, target, this.COOLDOWNS.TARGET_BLOCK);
            }
            
            log('[memória] Erro: ' + target + ' (falhas: ' + fails + ')', 'error');
        },
        
        // Bloquear target temporariamente
        blockTarget: function(villageId, target, duration) {
            var mem = this.get(villageId);
            var blocked = mem.blockedTargets || {};
            blocked[target] = Date.now() + (duration || this.COOLDOWNS.TARGET_BLOCK);
            this.set(villageId, 'blockedTargets', blocked);
            log('[memória] Target bloqueado: ' + target, 'warning');
        },
        
        // Verificar se target está bloqueado
        isTargetBlocked: function(villageId, target) {
            var mem = this.get(villageId);
            var blocked = mem.blockedTargets || {};
            if (blocked[target] && Date.now() < blocked[target]) {
                return true;
            }
            // Limpar expired
            for (var t in blocked) {
                if (Date.now() >= blocked[t]) {
                    delete blocked[t];
                }
            }
            if (Object.keys(blocked).length < (mem.blockedTargets ? Object.keys(mem.blockedTargets).length : 0)) {
                this.set(villageId, 'blockedTargets', blocked);
            }
            return false;
        },
        
        // Verificar se pode executar ação (actionLock + cooldown)
        canAct: function(villageId) {
            var mem = this.get(villageId);
            var now = Date.now();
            
            // Verificar actionLock
            if (mem.actionLock) {
                log('[memória] ActionLock ativo', 'warning');
                return false;
            }
            
            // Verificar cooldown global
            if (mem.cooldownUntil && now < mem.cooldownUntil) {
                log('[memória] Em cooldown por ' + Math.round((mem.cooldownUntil - now)/1000) + 's', 'warning');
                return false;
            }
            
            return true;
        },
        
        // Adquirir lock de ação
        acquireLock: function(villageId) {
            if (this.canAct(villageId)) {
                this.set(villageId, 'actionLock', true);
                return true;
            }
            return false;
        },
        
        // Liberar lock de ação
        releaseLock: function(villageId) {
            this.set(villageId, 'actionLock', false);
        },
        
        // Verificar se deve mudar de estratégia (muitas falhas)
        needsStrategyChange: function(villageId) {
            var mem = this.get(villageId);
            return (mem.consecutiveFails || 0) >= 3;
        },
        
        // Reset suave após período longo sem sucesso
        softReset: function(villageId) {
            var mem = this.get(villageId);
            if (mem.lastSuccess && Date.now() - mem.lastSuccess > this.COOLDOWNS.SOFT_RESET) {
                this.set(villageId, 'consecutiveFails', 0);
                this.set(villageId, 'blockedTargets', {});
                this.set(villageId, 'cooldownUntil', 0);
                log('[memória] Soft reset aplicado', 'warning');
                return true;
            }
            return false;
        }
    };

    // ============================================================
    // UTILS
    // ============================================================
    function log(msg, type) {
        if (!CONFIG.debug) return;
        type = type || 'info';
        var styles = { error: 'color:#ff4444', success: 'color:#00cc00', warning: 'color:#f39c12', info: 'color:#0088ff' };
        console.log('%c[TWBot ' + new Date().toLocaleTimeString() + '] ' + msg, styles[type] || styles.info);
        GM_log(msg);
    }

    function getScreenParam() { return new URL(window.location.href).searchParams.get('screen') || ''; }
    function getVillageIdParam() { return new URL(window.location.href).searchParams.get('village') || ''; }
    function getVillagePoints() {
        try { return parseInt((typeof game_data !== 'undefined' && game_data.village && game_data.village.points) || 0) || 0; } catch (e) { return 0; }
    }
    function getGamePhase(pts) { return pts < 500 ? 'EARLY' : pts < 5000 ? 'MID' : 'LATE'; }
    function getCurrentVillageId() {
        return getVillageIdParam() || (typeof game_data !== 'undefined' && game_data.village ? String(game_data.village.id) : null);
    }

    // ============================================================
    // HTTP
    // ============================================================
    function gmGet(url) {
        return new Promise(function (resolve, reject) {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url.startsWith('http') ? url : window.location.origin + url,
                headers: { 'X-Requested-With': 'XMLHttpRequest' },
                onload: function (r) { resolve(r.responseText); },
                onerror: function () { reject(new Error('GET falhou: ' + url)); },
            });
        });
    }

    function gmPost(url, data) {
        return new Promise(function (resolve, reject) {
            GM_xmlhttpRequest({
                method: 'POST',
                url: url.startsWith('http') ? url : window.location.origin + url,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                data: data,
                onload: function (r) { resolve(r.responseText); },
                onerror: function () { reject(new Error('POST falhou: ' + url)); },
            });
        });
    }

    // fetch nativo do navegador — usa as cookies da sessao sem restricoes de @connect
    function twFetch(url, method, body) {
        var win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
        var opts = {
            method: method || 'GET',
            credentials: 'include',
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
        };
        if (body) {
            opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
            opts.body = body;
        }
        return win.fetch(url, opts).then(function (r) { return r.text(); });
    }

    function gmGroq(prompt) {
        return new Promise(function (resolve) {
            if (!CONFIG.groqApiKey || CONFIG.groqApiKey === 'SUA_CHAVE_AQUI') { resolve(null); return; }
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://api.groq.com/openai/v1/chat/completions',
                headers: { Authorization: 'Bearer ' + CONFIG.groqApiKey, 'Content-Type': 'application/json' },
                data: JSON.stringify({
                    messages: [
                        { role: 'system', content: 'You are a Tribal Wars automation AI. Return ONLY valid JSON, no markdown, no explanation.' },
                        { role: 'user', content: prompt },
                    ],
                    model: CONFIG.groqModel,
                    temperature: 0.0,
                }),
                onload: function (r) {
                    try {
                        var json = JSON.parse(r.responseText);
                        resolve(json.choices && json.choices[0] ? json.choices[0].message.content.trim() : null);
                    } catch (e) { resolve(null); }
                },
                onerror: function () { resolve(null); },
            });
        });
    }

    // ============================================================
    // HUD PANEL - CAMADA 4 (PAINEL DE CONFIANÇA)
    // ============================================================
   // ============================================================
    // HUD PANEL - VISÃO GERENCIAL / EXPLICABILIDADE (CAMADA 4)
    // ============================================================
   // ============================================================
    // HUD PANEL - VISÃO GERENCIAL INTEGRADA (CAMADA 4)
    // ============================================================
    var HUD = {
        el: null, minimized: false,

        info: {
            fase: 'Calculando...',
            gargalo: 'Analisando...',
            meta: 'Sincronizando...',
            acao: 'Lendo sensores',
            motivo: 'Iniciando Camadas de decisão'
        },
        tasks: {
            flag: { label: 'Bandeira', status: 'idle', detail: '' },
            statue: { label: 'Estátua', status: 'idle', detail: '' },
            knight: { label: 'Paladino', status: 'idle', detail: '' },
            build_general: { label: 'Obras', status: 'idle', detail: '' }
        },

        init: function () {
            if (this.el) this.el.remove();
            this.minimized = GM_getValue('tw_hud_min', false);
            var el = document.createElement('div');
            el.id = 'tw-bot-hud';
            el.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#121417;color:#ecf0f1;border-radius:10px;font-family:sans-serif;font-size:12px;z-index:99999;box-shadow:0 0 25px rgba(0,0,0,.9);border:1px solid #f39c12;min-width:280px;user-select:none;transition:all .3s;line-height:1.4;';
            el.innerHTML = this._html();
            document.body.appendChild(el);
            this.el = el;
            el.querySelector('#tw-hud-toggle').onclick = () => { this.minimized = !this.minimized; GM_setValue('tw_hud_min', this.minimized); this._rerender(); };
        },

        _html: function () {
            var hdr = '<div id="tw-hud-toggle" style="padding:10px;cursor:pointer;color:#f39c12;font-weight:bold;background:#1a1c20;border-bottom:1px solid #333;display:flex;justify-content:space-between;border-top-left-radius:10px;border-top-right-radius:10px;">'
                    + '<span>⚔️ Agente Gerencial TW</span><span>' + (this.minimized ? '[ + ]' : '[ — ]') + '</span></div>';

            if (this.minimized) return hdr;

            // Bloco Gerencial (Topo)
            var rows = '<div style="padding: 10px;">';
            rows += '<div style="background:#1a1c20; padding:8px; border-radius:6px; margin-bottom:10px; border:1px solid #333;">';
            rows += '<div style="font-size:11px; color:#f39c12; font-weight:bold; margin-bottom:6px;">📊 VISÃO ESTRATÉGICA</div>';
            rows += this._buildDataRow('Fase:', this.info.fase, '#bdc3c7');
            rows += this._buildDataRow('Gargalo:', this.info.gargalo, '#e74c3c');
            rows += '<div style="margin-top:6px; padding-top:6px; border-top:1px dashed #333;"></div>';
            rows += this._buildDataRow('Meta Atual:', this.info.meta, '#3498db');
            rows += this._buildDataRow('Alvo de Fila:', this.info.acao, '#2ecc71');
            rows += '<div style="background:#202225; padding:6px; border-radius:5px; font-family:monospace; font-size:10.5px; color:#a29bfe; margin-top:8px;">'
                 + '💡 <b>Razão:</b> ' + this.info.motivo
                 + '</div></div>';

            // Bloco Operacional (Baixo)
            rows += '<div style="background:#1a1c20; padding:8px; border-radius:6px; border:1px solid #333;">';
            rows += '<div style="font-size:11px; color:#f39c12; font-weight:bold; margin-bottom:6px;">🔧 STATUS OPERACIONAL</div>';
            for (var taskId in this.tasks) {
                var task = this.tasks[taskId];
                var statusColor = this._getStatusColor(task.status);
                var statusIcon = this._getStatusIcon(task.status);
                rows += '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; padding:4px; background:#202225; border-radius:4px;">';
                rows += '<span style="color:#bdc3c7; font-size:11px;">' + task.label + '</span>';
                rows += '<span style="color:' + statusColor + '; font-size:10px; font-weight:600;">' + statusIcon + ' ' + task.detail;
                rows += '</span></div>';
            }
            rows += '</div></div>';

            return hdr + rows;
        },

        _getStatusColor: function(status) {
            var colors = {
                'idle': '#95a5a6',
                'running': '#f39c12',
                'done': '#2ecc71',
                'error': '#e74c3c',
                'skip': '#3498db',
                'waiting': '#9b59b6'
            };
            return colors[status] || '#95a5a6';
        },

        _getStatusIcon: function(status) {
            var icons = {
                'idle': '⏸',
                'running': '⚙',
                'done': '✓',
                'error': '✗',
                'skip': '⊘',
                'waiting': '⏳'
            };
            return icons[status] || '⏸';
        },

        _buildDataRow: function(label, value, valColor) {
            return '<div style="display:flex; justify-content:space-between; margin-bottom:4px;"><strong>' + label + '</strong><span style="color:' + valColor + '; font-weight:600; text-align:right;">' + value + '</span></div>';
        },

        _rerender: function () { if (this.el) this.el.innerHTML = this._html(); this.el.querySelector('#tw-hud-toggle').onclick = () => { this.minimized = !this.minimized; GM_setValue('tw_hud_min', this.minimized); this._rerender(); }; },

        // --- FUNÇÃO QUE ESTAVA FALTANDO (CORREÇÃO) ---
        addAudit: function(msg) {
            this.info.motivo = msg;
            this._rerender();
        },

        updateDiagnostics: function(fase, gargalo, meta, acao, motivo) {
            if (fase) this.info.fase = fase;
            if (gargalo) this.info.gargalo = gargalo;
            if (meta) this.info.meta = meta;
            if (acao) this.info.acao = acao;
            if (motivo) this.info.motivo = motivo;
            this._rerender();
        },

        set: function(id, status, detail) {
            // Atualiza status operacional da tarefa específica
            if (this.tasks[id]) {
                this.tasks[id].status = status || 'idle';
                this.tasks[id].detail = detail || '';
            }
            // Também atualiza o motivo geral para contexto
            if (detail) this.info.motivo = detail;
            this._rerender();
        }
    };
    // ============================================================
    // CSRF
    // ============================================================
    function extractCsrf(html) {
        var patterns = [
            /"csrf"\s*:\s*"([^"]{4,50})"/,
            /'csrf'\s*:\s*'([^']{4,50})'/,
            /[?&]h=([a-f0-9]{4,50})[&"'\s]/,
            /name="h"\s+value="([^"]{4,50})"/,
            /value="([a-f0-9]{4,50})"\s+name="h"/,
        ];
        for (var i = 0; i < patterns.length; i++) {
            var m = html.match(patterns[i]);
            if (m) return m[1];
        }
        try { if (typeof game_data !== 'undefined' && game_data.csrf) return game_data.csrf; } catch (e) {}
        return null;
    }

    // ============================================================
    // FLAG HELPERS
    // ============================================================
   function parseFlagsFromHtml(html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var candidates = [];
        var seen = {};

        doc.querySelectorAll('.flag_box').forEach(function (box) {
            // Ignora explicitamente se estiver vazio no HTML
            if (box.classList.contains('flag_box_empty')) return;

            var type = null, level = null;
            var boxStyle = box.getAttribute('style') || '';
            var bm = boxStyle.match(/(\d+)_(\d+)\.(?:webp|png|gif|jpg)/);
            if (bm) { type = parseInt(bm[1]); level = parseInt(bm[2]); }

            if (!type || !level) return;

            // --- MELHORIA AQUI: CHECAGEM REAL DE QUANTIDADE ---
            var countEl = box.querySelector('.flag_count, .flag-count');
            var count = countEl ? parseInt(countEl.textContent.replace(/\D/g, '')) : 0;

            // Se o contador for 0 ou não existir, ignora
            if (count <= 0) return;

            var key = type + '_' + level;
            if (seen[key]) return;
            seen[key] = true;

            candidates.push({
                type: type, level: level, count: count,
                category: FLAG_TYPE_MAP[type] || 'unknown'
            });
        });

        log('[flags] Scanner: ' + candidates.length + ' bandeiras reais encontradas no inventário.');
        return candidates;
    }
    function isFlagAssignedInHtml(html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var currentFlagBox = doc.querySelector('#current_flag, .flag_assigned');
        if (!currentFlagBox) return false;
        var style = currentFlagBox.getAttribute('style') || "";
        return style.indexOf('display:none') === -1 && style.indexOf('display: none') === -1;
    }
    function scoreFlagLocal(flag, phase) {
        return ((CATEGORY_PRIORITY[phase] || CATEGORY_PRIORITY.MID)[flag.category] || 0) + flag.level * 3;
    }

    function selectBestFlagLocal(flags, phase) {
        if (!flags.length) return null;
        return flags.slice().sort(function (a, b) { return scoreFlagLocal(b, phase) - scoreFlagLocal(a, phase); })[0];
    }

    // ============================================================
    // BACKGROUND: ASSIGN FLAG via AJAX Fantasma
    // 1. Baixa HTML de screen=flags → parseia candidatas por identidade (URL da imagem)
    // 2. Ordena por prioridade de fase, tenta cada uma sequencialmente
    // 3. O servidor diz quem voce possui: erro = pula para proxima, sucesso = para
    // ============================================================
    function bgAssignFlagGhost(villageId, phase) {
        var origin   = window.location.origin;
        var flagsUrl = origin + '/game.php?village=' + villageId + '&screen=flags';
        log('[flag] Background: aldeia ' + villageId);
        HUD.set('flag', 'running', 'Carregando bandeiras...');

        return gmGet(flagsUrl).then(function (html) {
            if (isFlagAssignedInHtml(html)) {
                log('[flag] Background: bandeira ja atribuida — skip');
                return { ok: false, detail: 'ja_atribuida' };
            }

            var csrf = extractCsrf(html);
            try { if (!csrf && typeof game_data !== 'undefined' && game_data.csrf) csrf = game_data.csrf; } catch (e) {}
            if (!csrf) { log('[flag] Background: CSRF ausente!', 'error'); return { ok: false, detail: 'sem_csrf' }; }

            var candidates = parseFlagsFromHtml(html);
            if (!candidates.length) return { ok: false, detail: 'sem_bandeiras' };

            // Ordena por prioridade e limita tentativas para nao sobrecarregar o servidor
            var ph = phase || 'MID';
            var sorted = candidates.slice()
                .sort(function (a, b) { return scoreFlagLocal(b, ph) - scoreFlagLocal(a, ph); })
                .slice(0, 20);

            log('[flag] ' + sorted.length + ' candidatas ordenadas — tentando em sequencia...');

            var assignUrl = origin + '/game.php?village=' + villageId + '&screen=flags&ajaxaction=assign_flag';

            function tryNext(i) {
                if (i >= sorted.length) {
                    log('[flag] Nenhuma bandeira aceita pelo servidor', 'warning');
                    return Promise.resolve({ ok: false, detail: 'sem_bandeiras_validas' });
                }

                var flag   = sorted[i];
                var detail = (FLAG_TYPE_MAP[flag.type] || 'tipo ' + flag.type) + ' Nv.' + flag.level;
                var body   = 'flag_type=' + flag.type + '&level=' + flag.level + '&village_id=' + villageId + '&h=' + csrf;

                log('[flag] Tentando ' + detail + ' (' + (i + 1) + '/' + sorted.length + ')');
                HUD.set('flag', 'running', 'Tentando ' + detail + '...');

                return twFetch(assignUrl, 'POST', body).then(function (resp) {
                    var assigned = false;
                    var rawStr   = '';
                    try {
                        var json = JSON.parse(resp);
                        rawStr   = JSON.stringify(json).toLowerCase();
                        assigned = !!(json && (json.success || json.error === false || json.result === 'success' || json.flag));
                        log('[flag] Resposta ' + detail + ': ' + JSON.stringify(json).slice(0, 120));
                    } catch (e) {
                        rawStr   = resp.toLowerCase();
                        assigned = isFlagAssignedInHtml(resp);
                    }

                    if (assigned) {
                        log('[flag] Bandeira ativada: ' + detail, 'success');
                        return { ok: true, detail: detail };
                    }

                    // Servidor confirmou que nao temos essa bandeira → proxima
                    var notOwned = rawStr.indexOf('no tiene') !== -1 || rawStr.indexOf('not have') !== -1
                                || rawStr.indexOf('nao tem')  !== -1 || rawStr.indexOf('does not own') !== -1
                                || rawStr.indexOf('"error"')  !== -1;
                    log('[flag] ' + detail + (notOwned ? ' nao possui' : ' rejeitada') + ' — proxima...', 'warning');
                    return tryNext(i + 1);

                }).catch(function () { return tryNext(i + 1); });
            }

            return tryNext(0).then(function (result) {
                if (result.ok) return result;
                // Verificacao final na pagina
                return new Promise(function (resolve) {
                    setTimeout(function () {
                        gmGet(flagsUrl).then(function (v) {
                            var verified = isFlagAssignedInHtml(v);
                            log('[flag] Verificacao final = ' + (verified ? 'ATIVADO' : 'FALHOU'), verified ? 'success' : 'error');
                            resolve({ ok: verified, detail: result.detail });
                        }).catch(function () { resolve(result); });
                    }, 1500);
                });
            });

        }).catch(function (e) {
            log('[flag] Background: erro = ' + (e.message || e), 'error');
            return { ok: false, detail: 'erro_rede' };
        });
    }

    // ============================================================
    // BACKGROUND: BUILD STATUE via AJAX puro
    // 1. POST ajaxaction=upgrade_building → enfileira construcao
    // 2. Extrai order ID do HTML atualizado
    // 3. GET ajaxaction=build_order_reduce → finaliza (se premium disponivel)
    // ============================================================
    function extractBuildOrderId(html) {
        var patterns = [
            /build_order_reduce[^"']*[?&]id=(\d+)/,
            /ajaxaction=build_order_reduce[^"]*id=(\d+)/,
            /"order_id"\s*:\s*(\d+)/,
            /buildorder.*?id=(\d+)/,
            /id=(\d+)&destroy=0/,
        ];
        for (var i = 0; i < patterns.length; i++) {
            var m = html.match(patterns[i]);
            if (m) return m[1];
        }
        return null;
    }

    function bgBuildStatue(villageId, csrf) {
        var origin  = window.location.origin;
        var mainUrl = origin + '/game.php?village=' + villageId + '&screen=main';
        log('[statue] Background AJAX: aldeia ' + villageId);
        HUD.set('statue', 'running', 'Verificando tela principal...');

        return gmGet(mainUrl).then(function (html) {
            var activeCsrf = csrf || extractCsrf(html);
            try { if (!activeCsrf && typeof game_data !== 'undefined' && game_data.csrf) activeCsrf = game_data.csrf; } catch (e) {}
            if (!activeCsrf) { log('[statue] CSRF ausente!', 'error'); return false; }

            // Verifica se ja esta em construcao
            var alreadyQueued = html.indexOf('statue') !== -1 && extractBuildOrderId(html);
            if (alreadyQueued) {
                log('[statue] Ja em fila de construcao' + (CONFIG.autoRushStatue ? ' — finalizando com ouro...' : ' — aguardando tempo normal.'));
                if (CONFIG.autoRushStatue) return tryFinish(alreadyQueued, activeCsrf);
                return true;
            }

            // POST para enfileirar a construcao
            var buildUrl = origin + '/game.php?village=' + villageId + '&screen=main&ajaxaction=upgrade_building&type=main';
            var body     = 'id=statue&force=1&destroy=0&source=' + villageId + '&h=' + activeCsrf;

            log('[statue] POST upgrade_building...');
            HUD.set('statue', 'running', 'Enfileirando construcao...');

            return twFetch(buildUrl, 'POST', body).then(function (resp) {
                var queued = false;
                var orderId = null;
                try {
                    var json = JSON.parse(resp);
                    log('[statue] Resposta build: ' + JSON.stringify(json).slice(0, 150));
                    queued  = !!(json && (json.success || json.error === false || json.order_id || json.id));
                    orderId = json && (json.order_id || json.id);
                } catch (e) {
                    queued  = resp.indexOf('success') !== -1 || resp.indexOf('order') !== -1;
                    orderId = extractBuildOrderId(resp);
                }

                if (!queued && !orderId) {
                    // Reconfirma via GET da pagina: botao de estatua sumindo = sucesso
                    return gmGet(mainUrl).then(function (html2) {
                        var doc2  = new DOMParser().parseFromString(html2, 'text/html');
                        var noBtn = !doc2.querySelector('a.btn-build[data-building="statue"]');
                        if (noBtn) {
                            log('[statue] Enfileirada (botao sumiu da pagina).', 'success');
                            if (CONFIG.autoRushStatue) {
                                orderId = extractBuildOrderId(html2);
                                if (orderId) return tryFinish(orderId, activeCsrf);
                            }
                            return true;
                        }
                        log('[statue] Falha ao enfileirar.', 'error');
                        return false;
                    });
                }

                log('[statue] Enfileirada' + (orderId ? ' orderId=' + orderId : '') + '.', 'success');
                if (CONFIG.autoRushStatue && orderId) return tryFinish(orderId, activeCsrf);
                return true;
            });
        }).catch(function (e) {
            log('[statue] Erro: ' + (e.message || e), 'error');
            return false;
        });

        function tryFinish(orderId, activeCsrf) {
            var reduceUrl = origin + '/game.php?village=' + villageId
                + '&screen=main&ajaxaction=build_order_reduce&id=' + orderId + '&destroy=0&h=' + activeCsrf;
            log('[statue] GET build_order_reduce id=' + orderId + '...');
            HUD.set('statue', 'running', 'Finalizando construcao...');
            return twFetch(reduceUrl, 'GET').then(function (resp) {
                try {
                    var json = JSON.parse(resp);
                    log('[statue] Rush resposta: ' + JSON.stringify(json).slice(0, 100));
                } catch (e) {}
                log('[statue] Finalizacao concluida (ou ignorada sem premium).', 'success');
                return true;
            }).catch(function () { return true; });
        }
    }

    // ============================================================
    // BACKGROUND: KNIGHT — consulta de estado Rápida (ByPass) + AJAX
    // ============================================================
    function getKnightState(villageId) {

        // --- ⚡ FAST BYPASS: VERIFICAÇÃO VISUAL / VARIÁVEIS DO JOGO ---
        var knightAvistadoNativamente = false;
        try {
            // O jogo guarda tropas nesta div direita, em icones globais, ou na var "game_data"
            // Checamos a barra de pop, unidades, etc.
            var iconeNaBarraDireita = document.querySelector('a.unit_link[data-unit="knight"], .unit-item.knight');
            var contagemGlobal = document.querySelector('.knight_icon');

            if (iconeNaBarraDireita || contagemGlobal) {
                knightAvistadoNativamente = true;
            }
        } catch(e) {}

        // Se já viu com os próprios olhos ou está marcado na memória das ultimas horas
        if (knightAvistadoNativamente) {
            log('[knight] ⚡ Bypass Ativado: O Paladino está claramente visível na Aldeia/Painel. Busca de background cancelada!', 'success');
            return Promise.resolve({ canRecruit: false, isPresent: true, isRecruiting: false, csrf: null });
        }
        // --------------------------------------------------------------

        // O Bypass não achou (pode estar morto aguardando renascer ou em ataque).
        // Nesse caso, cai no "Plano B": puxar via requisição o histórico dele na estátua.
        var url = window.location.origin + '/game.php?village=' + villageId + '&screen=statue&_=' + Date.now();

        function parseKnightHtml(html) {
            var canRecruit = html.indexOf('knight_recruit_launch') !== -1;
            var isRecruit = !canRecruit && (html.indexOf('knight_recruit_rush') !== -1 || html.indexOf('knight_progress') !== -1);

            var hasKnight = !canRecruit && !isRecruit && (
                html.indexOf('rename_knight')  !== -1 ||
                html.indexOf('knight_present') !== -1 ||
                html.indexOf('Verplaatsen')    !== -1
            );

            var csrf = extractCsrf(html);
            return { canRecruit: canRecruit, isPresent: hasKnight, isRecruiting: isRecruit, csrf: csrf };
        }

        return gmGet(url).then(parseKnightHtml).catch(function (e) {
            return twFetch(url, 'GET').then(parseKnightHtml);
        });
    }
    // ============================================================
    // BACKGROUND: RECRUIT KNIGHT via AJAX puro (sem iframe, sem DOM)
    // ============================================================
    function extractKnightIdExtremo(html) {
        var id = null;
        var doc = new DOMParser().parseFromString(html, 'text/html');

        // Pega O SEU BOTÃO específico!
        var btn = doc.querySelector('#knight_recruiting .knight_recruit_rush, .knight_recruit_rush');

        if (btn) {
            // 1. Tenta por atributos escondidos
            id = btn.getAttribute('data-knight') || btn.getAttribute('data-id') || btn.getAttribute('knight_id');

            // 2. Tenta caçar no href=?knight=4355
            if (!id) {
                var href = btn.getAttribute('href') || '';
                var mHref = href.match(/knight=(\d+)/i);
                if (mHref) id = mHref[1];
            }

            // 3. Tenta caçar no onclick="Knight.rush(4355)"
            if (!id) {
                var oc = btn.getAttribute('onclick') || '';
                var mOc = oc.match(/(\d{4,})/); // Paladinos geralmente tem ID acima de 1000
                if (mOc) id = mOc[1];
            }
        }

        // 4. Último caso: apela pro Regex varrendo a página inteira em busca desse ID maldito
        if (!id) {
            var match = html.match(/data-knight(?:-id)?=["'](\d+)/i) ||
                        html.match(/knight_id["']?\s*:\s*(\d+)/i) ||
                        html.match(/recruit_rush.*?knight=(\d+)/i) ||
                        html.match(/knight\s*=\s*['"]?(\d+)/i);
            if (match) id = match[1];
        }

        log('[knight] A extração encontrou o ID: ' + id);
        return id;
    }

    // ============================================================
    // BACKGROUND: RECRUIT KNIGHT (Bloqueio Inteligente de Limites)
    // ============================================================
   function bgRecruitKnight(villageId) {
        log('[knight] Verificando Paladino...');
        return getKnightState(villageId).then(function (state) {
            if (state.isPresent) return true;
            var recruitUrl = window.location.origin + '/game.php?village=' + villageId + '&screen=statue&ajaxaction=recruit';
            var body = 'home=' + villageId + '&name=Paul&h=' + (state.csrf || game_data.csrf);

            return twFetch(recruitUrl, 'POST', body).then(function (resp) {
                var json = {};
                try { json = JSON.parse(resp); } catch(e){}

                if (json && json.error) {
                    log('[knight] BLOQUEIO: ' + json.error[0], 'warning');
                    // Bloqueia por 24 horas para evitar spam
                    GM_setValue('knight_blocked_' + villageId, Date.now() + (24 * 60 * 60 * 1000));
                    return false;
                }
                log('[knight] Recrutamento iniciado com sucesso!', 'success');
                return true;
            });
        });
    }
    // ============================================================
    // Polling pos-construcao: tenta finalizar estatua e recrutar paladino
    // Em cada ciclo tenta build_order_reduce (estatua) e recruit_rush (paladino)
    // O servidor aceita quando o botao verde esta disponivel (<5min), ignora caso contrario
    // ============================================================
    function pollForKnightAfterStatue(villageId) {
        var INTERVAL_MS  = 30000;
        var MAX_ATTEMPTS = 40;
        var attempts     = 0;
        var origin       = window.location.origin;

        log('[poll] Iniciando (30s/ciclo, max 20min)...');
        HUD.set('knight', 'running', 'Aguardando estatua...');

        return new Promise(function (resolve) {
            function next() { setTimeout(check, INTERVAL_MS); }

            function tryKnightRush(csrf) {
                var statueUrl = origin + '/game.php?village=' + villageId + '&screen=statue&_=' + Date.now();
                return gmGet(statueUrl).then(function (html) {
                    var patterns = [
                        /recruit_rush[^"']*knight=(\d+)/,
                        /knight=(\d+)/,
                        /"knight_id"\s*:\s*(\d+)/,
                        /"knight"\s*:\s*(\d+)/i,
                        /data-knight[="](\d+)/,
                    ];
                    var knightId = null;
                    for (var i = 0; i < patterns.length && !knightId; i++) {
                        var m = html.match(patterns[i]); if (m) knightId = m[1];
                    }
                    if (!knightId) { log('[poll] Knight ID nao encontrado — aguardando.', 'warning'); return false; }
                    log('[poll] Knight ID=' + knightId + ' — POST recruit_rush (gratis se <5min)...');
                    var rushUrl  = origin + '/game.php?village=' + villageId + '&screen=statue&ajaxaction=recruit_rush';
                    var rushBody = 'knight=' + knightId + '&home=' + villageId + '&h=' + csrf;
                    return twFetch(rushUrl, 'POST', rushBody).then(function (r) {
                        try { log('[poll] Rush resposta: ' + JSON.stringify(JSON.parse(r)).slice(0, 100)); } catch (e) {}
                        return true;
                    }).catch(function () { return false; });
                }).catch(function () { return false; });
            }

            function check() {
                attempts++;
                if (attempts > MAX_ATTEMPTS) {
                    log('[poll] Timeout 20min', 'warning');
                    HUD.set('knight', 'error', 'Timeout (20min)');
                    resolve(false); return;
                }

                var remaining = ((MAX_ATTEMPTS - attempts) * INTERVAL_MS / 60000).toFixed(0);
                log('[poll] Ciclo ' + attempts + '/' + MAX_ATTEMPTS);

                Promise.all([
                    gmGet(origin + '/game.php?village=' + villageId + '&screen=main').catch(function () { return ''; }),
                    getKnightState(villageId).catch(function () { return { canRecruit: false, isPresent: false, isRecruiting: false, csrf: null }; }),
                ]).then(function (res) {
                    var mainHtml   = res[0];
                    var knightInfo = res[1];
                    var csrf = knightInfo.csrf || extractCsrf(mainHtml);
                    try { if (!csrf && typeof game_data !== 'undefined' && game_data.csrf) csrf = game_data.csrf; } catch (e) {}

                    // Paladino ja presente
                    if (knightInfo.isPresent) {
                        log('[poll] Paladino presente!', 'success');
                        HUD.set('knight', 'done', 'Presente!');
                        resolve(true); return;
                    }

                    // Estatua pronta — recrutar agora
                    if (knightInfo.canRecruit) {
                        log('[poll] Estatua pronta — recrutando!', 'success');
                        HUD.set('knight', 'running', 'Recrutando paladino...');
                        bgRecruitKnight(villageId).then(function (ok) {
                            if (ok) {
                                // Verifica se ja esta presente ou ainda em recrutamento (rush pendente)
                                getKnightState(villageId).then(function (s2) {
                                    if (s2.isPresent) { HUD.set('knight', 'done', 'Recrutado!'); resolve(true); }
                                    else { log('[poll] Rush pendente — continuando ciclos...'); next(); }
                                }).catch(function () { HUD.set('knight', 'done', 'Recrutado!'); resolve(true); });
                            } else {
                                HUD.set('knight', 'error', 'Falhou');
                                resolve(false);
                            }
                        }).catch(function () { resolve(false); });
                        return;
                    }

                    // Paladino em recrutamento — tenta rush (gratis se botao verde)
                    if (knightInfo.isRecruiting && csrf) {
                        log('[poll] Paladino em recrutamento — tentando rush gratuito...');
                        HUD.set('knight', 'running', 'Tentando finalizar paladino... (~' + remaining + 'min)');
                        tryKnightRush(csrf).then(function () { next(); }).catch(next);
                        return;
                    }

                    // Estatua ainda construindo — tenta finalizar (gratis se botao verde)
                    var orderId = extractBuildOrderId(mainHtml);
                    if (orderId && csrf) {
                        log('[poll] Estatua construindo (id=' + orderId + ') — tentando finalizar...');
                        HUD.set('knight', 'running', 'Tentando finalizar estatua... (~' + remaining + 'min)');
                        var reduceUrl = origin + '/game.php?village=' + villageId
                            + '&screen=main&ajaxaction=build_order_reduce&id=' + orderId + '&destroy=0&h=' + csrf;
                        twFetch(reduceUrl, 'GET').then(function (r) {
                            try { log('[poll] Reduce: ' + JSON.stringify(JSON.parse(r)).slice(0, 80)); } catch (e) {}
                            next();
                        }).catch(next);
                        return;
                    }

                    HUD.set('knight', 'running', 'Aguardando... (~' + remaining + 'min)');
                    next();

                }).catch(function (e) {
                    log('[poll] Erro: ' + (e.message || e), 'error');
                    next();
                });
            }

            setTimeout(check, 5000);
        });
    }

    // ============================================================
    // CAMADA 1: COLETOR DE ESTADO E RAIO-X ABSOLUTO (SEM IA)
    // ============================================================
   // ============================================================
    // CAMADA 1: COLETOR DE ESTADO E RAIO-X ABSOLUTO (SEM IA)
    // ============================================================
    const TW_BUILDING_REQS = {
        main:       {},
        barracks:   { main: 3 },
        church:     { main: 5, farm: 5 },
        watchtower: { main: 5, farm: 5 },
        stable:     { main: 10, barracks: 5, smith: 5 },
        garage:     { main: 10, smith: 10 },
        snob:       { main: 20, smith: 20, market: 10 },
        smith:      { main: 5, barracks: 1 },
        place:      {},
        statue:     {},
        market:     { main: 3, storage: 2 },
        wood:       {},
        stone:      {},
        iron:       {},
        farm:       {},
        storage:    {},
        hide:       {},
        wall:       { barracks: 1 }
    };

    // ============================================================
    // CAMADA DE VALIDAÇÃO DE BUILD EXECUTÁVEL (V6.0)
    // Verifica robustez: recursos, botão, fila, sucesso real
    // ============================================================
    
    /**
     * Extrai candidatos de construção diretamente do DOM
     * Retorna lista de edifícios com botões disponíveis
     */
    function getBuildCandidatesFromDOM(mainDoc) {
        var candidates = [];
        // Buscar todos os edifícios na tela de main
        mainDoc.querySelectorAll('.building-item, .lit-item, [id*="building_"]').forEach(el => {
            var buildingId = el.id.replace('building_', '').replace('main_building_', '');
            var upgradeBtn = el.querySelector('.upgrade-button, .btn-upgrade, a[href*="ajaxaction=upgrade"]');
            if (upgradeBtn && buildingId) {
                candidates.push({
                    id: buildingId,
                    element: el,
                    button: upgradeBtn,
                    hasButton: true
                });
            }
        });
        return candidates;
    }

    /**
     * Extrai custos de um edifício específico do DOM ou usa tabela de custos
     */
    function extractCosts(buildingId, mainDoc, fallbackCosts) {
        // Tentar extrair do tooltip ou elemento de custo no DOM
        var costEl = mainDoc.querySelector('#building_' + buildingId + ' .costs, .building-' + buildingId + ' .costs');
        if (costEl) {
            var text = costEl.textContent || costEl.innerText;
            var wood = parseInt(text.match(/(\d+)\s*madeira/i)?.[1] || text.match(/(\d+)\s*wood/i)?.[1] || '0');
            var stone = parseInt(text.match(/(\d+)\s*pedra/i)?.[1] || text.match(/(\d+)\s*stone/i)?.[1] || '0');
            var iron = parseInt(text.match(/(\d+)\s*ferro/i)?.[1] || text.match(/(\d+)\s*iron/i)?.[1] || '0');
            if (wood > 0 || stone > 0 || iron > 0) {
                return { wood: wood, stone: stone, iron: iron, fromDOM: true };
            }
        }
        // Fallback: usar tabela de custos com progressão por nível
        if (fallbackCosts) {
            return { wood: fallbackCosts[0], stone: fallbackCosts[1], iron: fallbackCosts[2], time: fallbackCosts[3], fromDOM: false };
        }
        return null;
    }

    /**
     * Verifica se há recursos suficientes AGORA para construir
     */
    function hasEnoughResources(buildingId, state, costs) {
        if (!costs) return false;
        var currentWood = state.recursos.wood || 0;
        var currentStone = state.recursos.stone || 0;
        var currentIron = state.recursos.iron || 0;
        
        var enough = (currentWood >= (costs.wood || 0)) &&
                     (currentStone >= (costs.stone || 0)) &&
                     (currentIron >= (costs.iron || 0));
        
        if (!enough) {
            log('[executável] ' + buildingId + ' bloqueado: recursos insuficientes', 'warn');
            log('  Necessário: W=' + (costs.wood||0) + ' S=' + (costs.stone||0) + ' I=' + (costs.iron||0));
            log('  Disponível: W=' + Math.round(currentWood) + ' S=' + Math.round(currentStone) + ' I=' + Math.round(currentIron));
        }
        return enough;
    }

    /**
     * Verifica se o botão de upgrade está disponível e clicável
     */
    function isButtonAvailable(buildingId, mainDoc) {
        var selectors = [
            '#building_' + buildingId + ' .upgrade-button:not(.disabled)',
            '#building_' + buildingId + ' .btn-upgrade:not(.disabled)',
            '#building_' + buildingId + ' a[href*="ajaxaction=upgrade"]:not(.disabled)',
            '.building-' + buildingId + ' .upgrade-button:not(.disabled)'
        ];
        
        for (var sel of selectors) {
            var btn = mainDoc.querySelector(sel);
            if (btn) {
                // Verificar se não está em cooldown ou bloqueado por outra razão
                var isDisabled = btn.classList.contains('disabled') || 
                                btn.hasAttribute('disabled') ||
                                btn.style.pointerEvents === 'none' ||
                                btn.getAttribute('aria-disabled') === 'true';
                if (!isDisabled) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Verifica se a construção entrou na fila após solicitação
     * Usado para validar sucesso real da ação
     */
    function verifyQueuedAfterBuild(responseText, buildingId) {
        try {
            var json = JSON.parse(responseText);
            // Verificar sucesso explícito
            if (json.success === true || json.order_id) {
                log('[verificação] ' + buildingId + ' entrou na fila com sucesso! OrderID: ' + (json.order_id || 'N/A'), 'success');
                return true;
            }
            // Verificar mensagens de erro comuns
            if (json.error) {
                log('[verificação] Erro ao construir ' + buildingId + ': ' + json.error, 'error');
                return false;
            }
        } catch (e) {
            // Fallback: buscar indicadores textuais de sucesso
            if (responseText.indexOf('success') !== -1 || 
                responseText.indexOf('order_id') !== -1 ||
                responseText.indexOf('queued') !== -1) {
                return true;
            }
        }
        return false;
    }

    /**
     * Validação completa de build executável
     * Combina todas as verificações: pré-requisitos, recursos, botão, fila
     */
    function isBuildExecutable(buildingId, state, mainDoc) {
        // 1. Pré-requisitos básicos
        if (!state.podeSerConstruido[buildingId]) {
            log('[executável] ' + buildingId + ' bloqueado: pré-requisitos não atendidos', 'warn');
            return false;
        }

        // 2. Verificar se botão está disponível no DOM
        if (!isButtonAvailable(buildingId, mainDoc)) {
            log('[executável] ' + buildingId + ' bloqueado: botão não disponível', 'warn');
            return false;
        }

        // 3. Extrair custos (priorizar DOM, fallback tabela)
        var baseCosts = TW_BUILDING_COSTS[buildingId];
        var nivelAtual = parseInt(state.niveis[buildingId] || 0);
        var costs = extractCosts(buildingId, mainDoc, baseCosts);
        
        if (!costs) {
            log('[executável] ' + buildingId + ' bloqueado: não foi possível determinar custos', 'warn');
            return false;
        }

        // Aplicar progressão de nível se veio da tabela
        if (!costs.fromDOM && baseCosts) {
            costs.wood = Math.floor(baseCosts[0] * Math.pow(1.5, nivelAtual));
            costs.stone = Math.floor(baseCosts[1] * Math.pow(1.5, nivelAtual));
            costs.iron = Math.floor(baseCosts[2] * Math.pow(1.5, nivelAtual));
            costs.time = Math.floor(baseCosts[3] * Math.pow(1.1, nivelAtual));
        }

        // 4. Verificar recursos suficientes
        if (!hasEnoughResources(buildingId, state, costs)) {
            return false;
        }

        // 5. Verificar se há vaga na fila
        var maxFila = state.premium.ativo ? 5 : 2;
        if (state.filaBuilds >= maxFila) {
            log('[executável] ' + buildingId + ' bloqueado: fila cheia (' + state.filaBuilds + '/' + maxFila + ')', 'warn');
            return false;
        }

        log('[executável] ' + buildingId + ' VERIFICADO: pronto para construir!', 'success');
        return true;
    }

   function timeToSeconds(timeStr) {
        if (!timeStr) return 9999;
        var parts = timeStr.replace(/[^\d:]/g, '').split(':').map(Number);
        if (parts.length === 3) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
        if (parts.length === 2) return (parts[0] * 60) + parts[1];
        return 9999;
    }

    function collectVillageState(villageId) {
        var origin = window.location.origin;
        var safeStr = function (p) { return p.catch(() => ''); };
        var statueEnabled = (typeof game_data !== 'undefined' && game_data.village.buildings.statue !== undefined);

        // Buscar dados adicionais para previsão de overflow (loot e rewards)
        // Nota: Em versão futura, buscar screen=overview_v para ataques em andamento
        // e screen=place para quests/tasks ativas
        
        return Promise.all([
            safeStr(gmGet(origin + '/game.php?village=' + villageId + '&screen=flags')),
            safeStr(gmGet(origin + '/game.php?village=' + villageId + '&screen=main')),
            statueEnabled ? getKnightState(villageId) : Promise.resolve({ canRecruit: false, isPresent: false, isRecruiting: false })
        ]).then(function (results) {
            var flagsHtml = results[0], mainHtml = results[1], statueInfo = results[2];
            var mainDoc = new DOMParser().parseFromString(mainHtml, 'text/html');
            var rawData = typeof game_data !== 'undefined' ? game_data : {};

            // --- DETECÇÃO DE RUSH (Obras e Paladino) ---
            var rushCandidates = [];
            mainDoc.querySelectorAll('#build_queue tr, .buildqueue_container tr').forEach(row => {
                var timerEl = row.querySelector('.timer');
                if (!timerEl) return;
                var secondsLeft = timeToSeconds(timerEl.textContent.trim());
                if (secondsLeft < 185) {
                    var idLink = row.querySelector('a[href*="id="]')?.getAttribute('href') || "";
                    var m = idLink.match(/id=(\d+)/);
                    if (m) rushCandidates.push(m[1]);
                }
            });

            var knightRushId = null;
            if (statueInfo.isRecruiting && statueInfo.htmlPura) {
                var mK = statueInfo.htmlPura.match(/knight=(\d+)/) || statueInfo.htmlPura.match(/data-knight=["'](\d+)/);
                if (mK) knightRushId = mK[1];
            }

            // Estimar loot esperado baseado em recursos disponíveis para saque (simplificado)
            // Em versão completa, buscar attacks em andamento via overview_v
            var lootEstimadoSimples = (rawData.village.wood_float + rawData.village.stone_float + rawData.village.iron_float) * 0.1; // 10% dos recursos como estimativa de loot incoming
            
            // Estimar rewards de quests (simplificado - seria preenchido via API de quests)
            var rewardsQuestsEstimado = 0; // Placeholder para integração futura com quests

            var state = {
                villageId: villageId,
                csrf: rawData.csrf || extractCsrf(mainHtml),
                statueEnabled: statueEnabled,
                recursos: { wood: rawData.village.wood_float, stone: rawData.village.stone_float, iron: rawData.village.iron_float, max: rawData.village.storage_max },
                producao: { wood: (parseFloat(rawData.village.wood_prod)||0)*3600, stone: (parseFloat(rawData.village.stone_prod)||0)*3600, iron: (parseFloat(rawData.village.iron_prod)||0)*3600 },
                populacao: { current: parseInt(rawData.village.pop), max: parseInt(rawData.village.pop_max) },
                niveis: rawData.village.buildings,
                filaBuilds: mainDoc.querySelectorAll('.lit-item, #build_queue tr .timer').length,
                rushIds: rushCandidates,
                knightRushId: knightRushId,
                premium: { ativo: !!(rawData.features?.Premium?.active) },
                phase: getGamePhase(parseInt(rawData.village.points)),
                flags: parseFlagsFromHtml(flagsHtml),
                flagAssigned: isFlagAssignedInHtml(flagsHtml), // CORRIGIDO
                knight: statueInfo,
                podeSerConstruido: {},
                // Sistema proativo de previsão de overflow
                lootEsperado: lootEstimadoSimples,      // Estimativa baseada em recursos (futuro: attacks em andamento)
                rewardsEsperados: rewardsQuestsEstimado, // Estimativa de rewards (futuro: integração quests)
                // Dados brutos do DOM para validação executável
                _mainDoc: mainDoc,
                _mainHtml: mainHtml
            };

            for (var ed in TW_BUILDING_REQS) {
                var travado = false;
                for (var nec in TW_BUILDING_REQS[ed]) { if (parseInt(state.niveis[nec]||0) < TW_BUILDING_REQS[ed][nec]) { travado = true; break; } }
                state.podeSerConstruido[ed] = !travado;
            }
            
            // Extrair candidatos executáveis do DOM (validação robusta)
            state.buildCandidatesDOM = getBuildCandidatesFromDOM(mainDoc);
            
            return state;
        });
    }
function motorDeDecisaoMacro(state, villageId) {
        var tasks = [];
        var maxFila = state.premium.ativo ? 5 : 2;
        
        // Carregar memória da aldeia
        var memory = VillageMemory.get(villageId);
        
        var visHUD = { fase: state.phase, gargalo: 'OK', meta: 'Calculando...', acao: 'Monitorando', motivo: 'Ativo' };
        
        // Verificar se deve mudar estratégia por falhas consecutivas
        if (VillageMemory.needsStrategyChange(villageId)) {
            log('[motorDeDecisao] Muitas falhas consecutivas, ajustando estratégia', 'warning');
            visHUD.gargalo = 'AJUSTE';
            visHUD.motivo = 'Falhas consecutivas detectadas';
        }
        
        // Carregar perfil do jogador (padrão: balanced)
        var playerProfile = GM_getValue('player_profile_' + state.villageId, 'balanced');
        var profile = PLAYER_PROFILES[playerProfile] || PLAYER_PROFILES.balanced;

        // 1. RUSH GRÁTIS (Sempre primeiro)
        if (state.rushIds.length > 0) {
            state.rushIds.forEach(id => tasks.push({ id: 'build_rush', action: 'DO', orderId: id }));
            visHUD.acao = "RUSH OBRA"; visHUD.motivo = "Limpando fila.";
            HUD.set('build_general', 'running', 'Finalizando obras');
            HUD.updateDiagnostics(visHUD.fase, visHUD.gargalo, visHUD.meta, visHUD.acao, visHUD.motivo);
            return Promise.resolve(tasks);
        }

        if (state.knightRushId) {
            tasks.push({ id: 'knight_rush', action: 'DO', knightId: state.knightRushId });
            visHUD.acao = "RUSH PALADINO"; visHUD.motivo = "Finalizando herói!";
            HUD.set('knight', 'running', 'Recrutamento em rush');
            HUD.updateDiagnostics(visHUD.fase, visHUD.gargalo, visHUD.meta, visHUD.acao, visHUD.motivo);
            return Promise.resolve(tasks);
        }

        // 2. BANDEIRA (Se não houver nenhuma ativa)
        if (!state.flagAssigned) {
            var best = state.flags.sort((a,b) => (CATEGORY_PRIORITY[state.phase][b.category] + b.level*3) - (CATEGORY_PRIORITY[state.phase][a.category] + a.level*3))[0];
            if (best) {
                tasks.push({ id: 'flag', action: 'DO', reason: "Ativando " + best.category });
                visHUD.acao = "BANDEIRA"; visHUD.motivo = "Otimizando produção.";
                HUD.set('flag', 'running', 'Selecionando categoria');
            } else {
                HUD.set('flag', 'idle', 'Sem bandeiras disponíveis');
            }
        } else {
            HUD.set('flag', 'done', 'Bandeira ativa');
        }

        // 3. PALADINO (Com trava de erro do servidor + memória)
        var pBlock = GM_getValue('knight_blocked_' + state.villageId, 0);
        if (state.knight.canRecruit && Date.now() > pBlock) {
            tasks.push({ id: 'knight', action: 'DO' });
            visHUD.acao = "RECRUTAR PALADINO";
            HUD.set('knight', 'running', 'Pronto para recrutar');
        } else if (state.knight.isRecruiting) {
            HUD.set('knight', 'waiting', 'Recrutando...');
        } else if (!state.knight.isPresent) {
            HUD.set('knight', 'idle', 'Estátua não construída');
        } else {
            HUD.set('knight', 'done', 'Paladino ativo');
        }

        // 4. MARCOS ESTRATÉGICOS (Milestones) - com persistência
        var activeMilestone = MILESTONES.find(m => {
            for (var ed in m.reqs) {
                if (state.niveis[ed] === undefined) continue;
                if (parseInt(state.niveis[ed] || 0) < m.reqs[ed]) return true;
            }
            return false;
        });
        
        // Persistir milestone atual na memória
        if (activeMilestone) {
            visHUD.meta = activeMilestone.label;
            if (memory.currentMilestone !== activeMilestone.id) {
                VillageMemory.set(villageId, 'currentMilestone', activeMilestone.id);
            }
        } else {
            visHUD.meta = "Otimização";
        }

        // Atualizar status da estátua
        if (state.statueEnabled) {
            if (state.knight.isPresent) {
                HUD.set('statue', 'done', 'Construída');
            } else if (state.knight.isRecruiting) {
                HUD.set('statue', 'running', 'Recrutando paladino');
            } else {
                HUD.set('statue', 'idle', 'Disponível');
            }
        } else {
            HUD.set('statue', 'skip', 'Não disponível');
        }

        // 5. OBRAS GERAIS COM MOTOR DE PRECISÃO
        if (state.filaBuilds < maxFila) {
            var selectedTarget = null;
            var taxaPop = (state.populacao.current / (state.populacao.max || 1)) * 100;
            
            // ==========================================
            // SISTEMA PROATIVO DE FARM - 4 NÍVEIS DE ALERTA
            // ==========================================
            // 82% → observação | 88% → preparação | 92% → prioridade alta | 95%+ → emergência
            var nivelAlertaFarm = 'normal';
            if (taxaPop >= 95) nivelAlertaFarm = 'emergencia';
            else if (taxaPop >= 92) nivelAlertaFarm = 'prioridade_alta';
            else if (taxaPop >= 88) nivelAlertaFarm = 'preparacao';
            else if (taxaPop >= 82) nivelAlertaFarm = 'observacao';
            
            // ==========================================
            // SISTEMA PROATIVO DE STORAGE - PREVISÃO DE OVERFLOW
            // ==========================================
            // Considera: produção atual, loot esperado, rewards, tempo até próxima conclusão
            var riscoArmazem = false;
            var recursosPercent = {
                wood: state.recursos.wood / state.recursos.max,
                stone: state.recursos.stone / state.recursos.max,
                iron: state.recursos.iron / state.recursos.max
            };
            
            // Calcular produção total por hora de todos os recursos
            var producaoTotalHora = (state.producao.wood || 0) + (state.producao.stone || 0) + (state.producao.iron || 0);
            
            // Estimar loot esperado baseado em ataques em andamento (se disponível)
            var lootEsperado = state.lootEsperado || 0;
            
            // Estimar rewards de quests/tasks (se disponível)
            var rewardsEsperados = state.rewardsEsperados || 0;
            
            // Recursos totais projetados (atual + produção + loot + rewards)
            var recursosTotaisProjetados = state.recursos.wood + state.recursos.stone + state.recursos.iron + lootEsperado + rewardsEsperados;
            var capacidadeTotalArmazem = state.recursos.max * 3; // 3 recursos
            
            // Percentual projetado considerando influxo futuro
            var percentualProjetado = recursosTotaisProjetados / capacidadeTotalArmazem;
            
            // Verificar overflow iminente para cada recurso individualmente
            var tempoAteOverflow = { wood: 999, stone: 999, iron: 999 };
            for (var res in recursosPercent) {
                if (recursosPercent[res] > 0.8) {
                    var producaoHora = state.producao[res] || 1;
                    var capacidadeRestante = state.recursos.max - state.recursos[res];
                    var horas = capacidadeRestante / (producaoHora || 1);
                    tempoAteOverflow[res] = horas;
                }
            }
            
            // Risco de armazém cheio: se algum recurso >95% OU projetado >90%
            if (recursosPercent.wood > 0.95 || recursosPercent.stone > 0.95 || recursosPercent.iron > 0.95 || percentualProjetado > 0.90) {
                riscoArmazem = true;
            }
            
            // Calcular tempo até gargalo mais crítico (em horas)
            var tempoAteGargalo = 999;
            for (var res in tempoAteOverflow) {
                if (tempoAteOverflow[res] < tempoAteGargalo) {
                    tempoAteGargalo = tempoAteOverflow[res];
                }
            }
            
            // Ajustar tempo até gargalo considerando loot e rewards
            if (lootEsperado > 0 || rewardsEsperados > 0) {
                var influxoExtraHora = (lootEsperado + rewardsEsperados) / 24; // Distribuído em 24h
                var capacidadeRestanteTotal = (state.recursos.max * 3) - (state.recursos.wood + state.recursos.stone + state.recursos.iron);
                var tempoComInfluxoExtra = capacidadeRestanteTotal / ((producaoTotalHora || 1) + influxoExtraHora);
                if (tempoComInfluxoExtra < tempoAteGargalo) {
                    tempoAteGargalo = tempoComInfluxoExtra;
                }
            }

            // ==========================================
            // PRIORIDADE 1: GARGALO DE POPULAÇÃO (FARM)
            // ==========================================
            // Emergência (95%+): Farm prioritário absoluto
            // Prioridade Alta (92-95%): Farm com alta prioridade
            // Preparação (88-92%): Farm se houver vaga e sem gargalo mais urgente
            // Observação (82-88%): Considerar farm no score
            if (nivelAlertaFarm === 'emergencia' && state.podeSerConstruido['farm']) {
                selectedTarget = 'farm'; 
                visHUD.gargalo = "POPULAÇÃO (EMERGÊNCIA)";
                visHUD.motivo = "População em " + Math.round(taxaPop) + "% - Paralisando crescimento!";
            }
            // PRIORIDADE 1B: Risco iminente de armazém cheio (<1.5h para encher)
            else if (riscoArmazem && tempoAteGargalo < 1.5) {
                // Escolher edifício de recurso mais carente
                var recursoMaisCarente = Object.keys(recursosPercent).reduce((a, b) => recursosPercent[a] > recursosPercent[b] ? a : b);
                if (state.podeSerConstruido[recursoMaisCarente]) {
                    selectedTarget = recursoMaisCarente;
                    visHUD.gargalo = "ARMAZÉM CHEIO (CRÍTICO)";
                    visHUD.motivo = Math.round(recursosPercent[recursoMaisCarente]*100) + "% - " + Math.round(tempoAteGargalo*60) + "min";
                }
            }
            // PRIORIDADE 1C: Farm em nível de prioridade alta (92-95%)
            else if (nivelAlertaFarm === 'prioridade_alta' && state.podeSerConstruido['farm']) {
                selectedTarget = 'farm';
                visHUD.gargalo = "POPULAÇÃO (ALTA)";
                visHUD.motivo = "População em " + Math.round(taxaPop) + "% - Expansão necessária";
            }
            // PRIORIDADE 3: Marcos estratégicos com análise de custo-benefício
            else if (activeMilestone) {
                // FILTRO DE CANDIDATOS EXECUTÁVEIS (validação robusta)
                var candidatos = Object.keys(activeMilestone.reqs).filter(ed => {
                    // Pré-requisitos básicos
                    if (state.niveis[ed] === undefined) return false;
                    if (parseInt(state.niveis[ed]||0) >= activeMilestone.reqs[ed]) return false;
                    if (!state.podeSerConstruido[ed]) return false;
                    
                    // Validação executável completa (recursos, botão, fila)
                    if (!isBuildExecutable(ed, state, state._mainDoc)) return false;
                    
                    return true;
                });
                
                if (candidatos.length > 0) {
                    // Calcular score baseado em: custo real, retorno por tempo, peso estratégico
                    var nivelHQ = parseInt(state.niveis['main'] || 0);
                    var bonusHQ = HQ_PRODUCTIVITY_BONUS[nivelHQ] || 0;
                    
                    var scores = candidatos.map(function(ed) {
                        var custo = TW_BUILDING_COSTS[ed] || [100, 100, 100, 100];
                        var nivelAtual = parseInt(state.niveis[ed] || 0);
                        var custoTotalMadeira = custo[0] * Math.pow(1.5, nivelAtual);
                        var custoTotalPedra = custo[1] * Math.pow(1.5, nivelAtual);
                        var custoTotalFerro = custo[2] * Math.pow(1.5, nivelAtual);
                        var tempoConstrucao = custo[3] * Math.pow(1.1, nivelAtual);
                        
                        // Custo total normalizado
                        var custoNormalizado = (custoTotalMadeira + custoTotalPedra + custoTotalFerro) / 100;
                        
                        // Retorno por recurso (edifícios de recurso têm retorno contínuo)
                        var retornoRecurso = ['wood', 'stone', 'iron', 'farm'].includes(ed) ? 1.5 : 1.0;
                        
                        // Peso estratégico baseado na fase e perfil do jogador
                        var pesoBase = STRATEGIC_WEIGHT[state.phase][ed] || 1.0;
                        var ajustePerfil = 1.0;
                        
                        // Ajustar pelo perfil do jogador
                        if (['wood', 'stone', 'iron'].includes(ed)) ajustePerfil = profile.resource;
                        else if (['barracks', 'stable', 'garage', 'smith'].includes(ed)) ajustePerfil = profile.military;
                        else if (['wall', 'hide', 'church', 'watchtower'].includes(ed)) ajustePerfil = profile.defense;
                        else if (['main', 'market', 'snob'].includes(ed)) ajustePerfil = profile.expansion;
                        
                        // Tempo até resolver gargalo atual (agora usa sistema de níveis de alerta)
                        var urgenciaGargalo = 1.0;
                        if (ed === 'farm') {
                            // Farm: urgência baseada no nível de alerta do sistema proativo
                            if (nivelAlertaFarm === 'emergencia') urgenciaGargalo = 2.0;
                            else if (nivelAlertaFarm === 'prioridade_alta') urgenciaGargalo = 1.5;
                            else if (nivelAlertaFarm === 'preparacao') urgenciaGargalo = 1.2;
                            else if (nivelAlertaFarm === 'observacao') urgenciaGargalo = 1.1;
                        }
                        if (riscoArmazem && ['wood', 'stone', 'iron'].includes(ed)) {
                            // Storage: urgência baseada no tempo até overflow
                            if (tempoAteGargalo < 0.5) urgenciaGargalo = 2.5; // <30min = crítico
                            else if (tempoAteGargalo < 1.0) urgenciaGargalo = 2.0; // <1h = muito urgente
                            else if (tempoAteGargalo < 1.5) urgenciaGargalo = 1.5; // <1.5h = urgente
                            else urgenciaGargalo = 1.2;
                        }
                        
                        // Bônus do HQ como acelerador de throughput global
                        // HQ não é só mais um edifício - é multiplicador de produtividade
                        var bonusHQProdutoividade = 1.0;
                        if (ed === 'main') {
                            // Investir no HQ dá retorno exponencial: acelera TODAS as construções futuras
                            // Quanto maior o nível atual do HQ, maior o ganho marginal de upar mais
                            bonusHQProdutoividade = 1.0 + (bonusHQ * 2.5); // Multiplicador agressivo para HQ
                        } else {
                            // Outros edifícios se beneficiam do HQ existente
                            bonusHQProdutoividade = 1.0 + bonusHQ;
                        }
                        
                        // Score final: (peso * retorno * urgencia * perfil * bonusHQ) / (custo * (nivel+1))
                        var score = (pesoBase * retornoRecurso * urgenciaGargalo * ajustePerfil * bonusHQProdutoividade) / (custoNormalizado * (nivelAtual + 1) * 0.1);
                        
                        // Bonus por ser pré-requisito direto de outras construções importantes
                        var bonusPreReq = 0;
                        for (var otherEd in TW_BUILDING_REQS) {
                            if (TW_BUILDING_REQS[otherEd][ed] && !state.podeSerConstruido[otherEd]) {
                                bonusPreReq += 0.2;
                            }
                        }
                        
                        // Bônus adicional para marcos estratégicos do HQ
                        if (ed === 'main') {
                            if (nivelAtual < 5) score *= 1.3; // Rush para hq_early
                            else if (nivelAtual >= 5 && nivelAtual < 10) score *= 1.2; // Rush para hq_mid
                        }
                        
                        return { ed: ed, score: score + bonusPreReq, custo: custoNormalizado, tempo: tempoConstrucao };
                    });
                    
                    // Ordenar por score decrescente
                    scores.sort((a, b) => b.score - a.score);
                    
                    selectedTarget = scores[0].ed;
                    visHUD.gargalo = "CUSTO-BENEFÍCIO";
                    visHUD.motivo = "Score: " + scores[0].score.toFixed(2) + " | Custo: " + Math.round(scores[0].custo);
                }
            }
            // PRIORIDADE 4: Otimização geral baseada em score quando não há milestone ativo
            else {
                // FILTRO DE CANDIDATOS EXECUTÁVEIS (validação robusta)
                var todosCandidatos = Object.keys(TW_BUILDING_REQS).filter(ed => {
                    if (!state.podeSerConstruido[ed]) return false;
                    if (ed === 'snob') return false; // Snob só via milestone específico
                    if ((state.niveis[ed] || 0) >= 25) return false; // Limite prático
                    
                    // Validação executável completa
                    return isBuildExecutable(ed, state, state._mainDoc);
                });

                if (todosCandidatos.length > 0) {
                    var nivelHQ = parseInt(state.niveis['main'] || 0);
                    var bonusHQ = HQ_PRODUCTIVITY_BONUS[nivelHQ] || 0;
                    
                    var scoresGerais = todosCandidatos.map(function(ed) {
                        var custo = TW_BUILDING_COSTS[ed] || [100, 100, 100, 100];
                        var nivelAtual = parseInt(state.niveis[ed] || 0);
                        var custoNormalizado = ((custo[0] + custo[1] + custo[2]) * Math.pow(1.5, nivelAtual)) / 100;
                        var pesoBase = STRATEGIC_WEIGHT[state.phase][ed] || 1.0;
                        var ajustePerfil = 1.0;

                        if (['wood', 'stone', 'iron'].includes(ed)) ajustePerfil = profile.resource;
                        else if (['barracks', 'stable', 'garage', 'smith'].includes(ed)) ajustePerfil = profile.military;
                        else if (['wall', 'hide', 'church', 'watchtower'].includes(ed)) ajustePerfil = profile.defense;
                        else if (['main', 'market', 'snob'].includes(ed)) ajustePerfil = profile.expansion;

                        // Bônus do HQ como acelerador de throughput global
                        var bonusHQProdutoividade = 1.0;
                        if (ed === 'main') {
                            bonusHQProdutoividade = 1.0 + (bonusHQ * 2.5);
                        } else {
                            bonusHQProdutoividade = 1.0 + bonusHQ;
                        }

                        // Sistema proativo de urgência para Farm e Storage (mesma lógica do milestone)
                        var urgenciaGargaloGeral = 1.0;
                        if (ed === 'farm') {
                            if (nivelAlertaFarm === 'emergencia') urgenciaGargaloGeral = 2.0;
                            else if (nivelAlertaFarm === 'prioridade_alta') urgenciaGargaloGeral = 1.5;
                            else if (nivelAlertaFarm === 'preparacao') urgenciaGargaloGeral = 1.2;
                            else if (nivelAlertaFarm === 'observacao') urgenciaGargaloGeral = 1.1;
                        }
                        if (riscoArmazem && ['wood', 'stone', 'iron'].includes(ed)) {
                            if (tempoAteGargalo < 0.5) urgenciaGargaloGeral = 2.5;
                            else if (tempoAteGargalo < 1.0) urgenciaGargaloGeral = 2.0;
                            else if (tempoAteGargalo < 1.5) urgenciaGargaloGeral = 1.5;
                            else urgenciaGargaloGeral = 1.2;
                        }

                        var score = (pesoBase * ajustePerfil * bonusHQProdutoividade * urgenciaGargaloGeral) / (custoNormalizado * (nivelAtual + 1) * 0.1);
                        
                        // Bônus adicional para marcos estratégicos do HQ
                        if (ed === 'main') {
                            if (nivelAtual < 5) score *= 1.3;
                            else if (nivelAtual >= 5 && nivelAtual < 10) score *= 1.2;
                        }
                        
                        return { ed: ed, score: score };
                    });

                    scoresGerais.sort((a, b) => b.score - a.score);
                    selectedTarget = scoresGerais[0].ed;
                    visHUD.gargalo = "OTIMIZAÇÃO";
                    visHUD.motivo = "Melhor ROI: " + selectedTarget;
                }
            }
            if (selectedTarget) {
                // Verificar se target foi bloqueado por falhas anteriores
                if (VillageMemory.isTargetBlocked(villageId, selectedTarget)) {
                    log('[motorDeDecisao] Target ' + selectedTarget + ' está bloqueado, buscando alternativa', 'warning');
                    visHUD.gargalo = 'BLOQUEADO';
                    visHUD.motivo = 'Target anterior falhou, evitando repetição';
                    // Não adicionar este target às tarefas
                } else {
                    tasks.push({ id: 'build_general', action: 'DO', target: selectedTarget });
                    visHUD.acao = selectedTarget.toUpperCase();
                    HUD.set('build_general', 'running', 'Construindo ' + selectedTarget);
                    
                    // Persistir gargalo anterior para comparação futura
                    if (memory.previousBottleneck !== visHUD.gargalo) {
                        VillageMemory.set(villageId, 'previousBottleneck', visHUD.gargalo);
                    }
                }
            } else {
                HUD.set('build_general', 'idle', 'Aguardando vaga na fila');
            }
        } else {
            HUD.set('build_general', 'waiting', 'Fila cheia (' + state.filaBuilds + '/' + maxFila + ')');
        }

        // Atualizar memória com última ação planejada
        if (tasks.length > 0 && !memory.actionLock) {
            var lastTask = tasks[tasks.length - 1];
            if (lastTask.target) {
                VillageMemory.set(villageId, 'lastTarget', lastTask.target);
            }
        }
        
        HUD.updateDiagnostics(visHUD.fase, visHUD.gargalo, visHUD.meta, visHUD.acao, visHUD.motivo);
        return Promise.resolve(tasks);
    }
    function bgBuildGeneric(villageId, building, csrf) {
        var origin = window.location.origin;
        var buildUrl = origin + '/game.php?village=' + villageId + '&screen=main&ajaxaction=upgrade_building&type=main';
        var body = 'id=' + building + '&force=1&destroy=0&source=' + villageId + '&h=' + csrf;

        log('[builder] Solicitando upgrade de ' + building + '...');
        return twFetch(buildUrl, 'POST', body).then(function (resp) {
            // Usar camada de verificação robusta
            var success = verifyQueuedAfterBuild(resp, building);
            if (success) {
                log('[builder] ' + building + ' confirmado na fila!', 'success');
            } else {
                log('[builder] Falha ao confirmar ' + building + ' na fila', 'error');
            }
            return success;
        });
    }

   // ============================================================
    // MAIN CHECKLIST ORCHESTRATOR - O CORAÇÃO DO BOT (V5.2)
    // ============================================================
   function bgBuildRush(villageId, orderId, csrf) {
        var url = window.location.origin + '/game.php?village=' + villageId + '&screen=main&ajaxaction=build_order_reduce&id=' + orderId + '&destroy=0&h=' + csrf;
        log('[rush] Disparando finalização instantânea para ID: ' + orderId, 'info');

        return twFetch(url, 'GET').then(resp => {
            log('[rush] Resposta do servidor recebida.', 'success');
            return true;
        }).catch(() => false);
    }
    function runChecklist(villageId) {
        HUD.init();
        
        // Aplicar soft reset se necessário
        VillageMemory.softReset(villageId);
        
        // Verificar se aldeia pode executar ações (actionLock + cooldown)
        if (!VillageMemory.canAct(villageId)) {
            log('[runChecklist] Aldeia ' + villageId + ' em cooldown ou bloqueada, aguardando...', 'warning');
            setTimeout(() => runChecklist(villageId), CONFIG.mainLoopInterval);
            return;
        }
        
        // Adquirir lock de ação
        if (!VillageMemory.acquireLock(villageId)) {
            log('[runChecklist] Não foi possível adquirir actionLock', 'warning');
            setTimeout(() => runChecklist(villageId), 3000);
            return;
        }
        
        collectVillageState(villageId).then(function (state) {
            return motorDeDecisaoMacro(state, villageId).then(function (tasks) {

                var queue = tasks.filter(t => t.action === 'DO');

                function execNext(i) {
                    if (i >= queue.length) {
                        // Liberar lock ao finalizar todas as tarefas
                        VillageMemory.releaseLock(villageId);
                        var wait = queue.length > 0 ? 5000 : CONFIG.mainLoopInterval;
                        setTimeout(() => runChecklist(villageId), wait);
                        return;
                    }

                    var task = queue[i];
                    var p = Promise.resolve();

                    if (task.id === 'build_rush') {
                        p = bgBuildRush(villageId, task.orderId, state.csrf)
                            .then(function(success) {
                                if (success) {
                                    VillageMemory.recordSuccess(villageId, 'rush_' + task.orderId);
                                } else {
                                    VillageMemory.recordError(villageId, 'rush_' + task.orderId, 'rush_fail');
                                }
                                return success;
                            });
                    }
                    else if (task.id === 'knight_rush') {
                        p = bgRushKnight(villageId, task.knightId, state.csrf)
                            .then(function(success) {
                                if (success) {
                                    VillageMemory.recordSuccess(villageId, 'knight_rush_' + task.knightId);
                                } else {
                                    VillageMemory.recordError(villageId, 'knight_rush_' + task.knightId, 'knight_rush_fail');
                                }
                                return success;
                            });
                    }
                    else if (task.id === 'build_general') {
                        // Verificar se target está bloqueado
                        if (VillageMemory.isTargetBlocked(villageId, task.target)) {
                            log('[executor] Target ' + task.target + ' está bloqueado, pulando', 'warning');
                            p = Promise.resolve(false);
                        }
                        // Validação final antes de executar: garantir que ainda é executável
                        else if (isBuildExecutable(task.target, state, state._mainDoc)) {
                            p = bgBuildGeneric(villageId, task.target, state.csrf)
                                .then(function(success) {
                                    if (success) {
                                        log('[executor] ' + task.target + ' iniciado com sucesso!', 'success');
                                        VillageMemory.recordSuccess(villageId, task.target);
                                    } else {
                                        log('[executor] Falha ao iniciar ' + task.target + ', registrando erro', 'error');
                                        VillageMemory.recordError(villageId, task.target, 'build_fail');
                                    }
                                    return success;
                                });
                        } else {
                            log('[executor] ' + task.target + ' não é mais executável, pulando', 'warn');
                            p = Promise.resolve(false);
                        }
                    }
                    else if (task.id === 'statue') {
                        p = bgBuildStatue(villageId, state.csrf)
                            .then(function(success) {
                                if (success) {
                                    VillageMemory.recordSuccess(villageId, 'statue');
                                } else {
                                    VillageMemory.recordError(villageId, 'statue', 'statue_fail');
                                }
                                return success;
                            });
                    }
                    else if (task.id === 'knight') {
                        p = bgRecruitKnight(villageId)
                            .then(function(success) {
                                if (success) {
                                    VillageMemory.recordSuccess(villageId, 'knight');
                                } else {
                                    VillageMemory.recordError(villageId, 'knight', 'knight_fail');
                                }
                                return success;
                            });
                    }
                    else if (task.id === 'flag') {
                        p = bgAssignFlagGhost(villageId, state.phase)
                            .then(function(success) {
                                if (success) {
                                    VillageMemory.recordSuccess(villageId, 'flag');
                                } else {
                                    VillageMemory.recordError(villageId, 'flag', 'flag_fail');
                                }
                                return success;
                            });
                    }

                    p.then(function() {
                        setTimeout(() => execNext(i + 1), 1500);
                    }).catch(function(err) {
                        log('[executor] Erro inesperado: ' + err, 'error');
                        VillageMemory.recordError(villageId, task.target || task.id, 'unexpected_error');
                        setTimeout(() => execNext(i + 1), 1500);
                    });
                }
                execNext(0);
            });
        });
    }
    // ============================================================
    // SCREEN MODES — interacao direta com o DOM quando usuario JA
    // esta na tela certa (feedback visual + clique nos elementos reais)
    // ============================================================

    function waitAndClick(selector, label, timeoutMs, requireVisible) {
        timeoutMs = timeoutMs || 4000;
        return new Promise(function (resolve, reject) {
            var elapsed = 0;
            var timer = setInterval(function () {
                var el = document.querySelector(selector);
                // requireVisible: ignora elementos pre-renderizados ocultos (offsetParent === null)
                if (el && (!requireVisible || el.offsetParent !== null)) {
                    clearInterval(timer); log('"' + label + '" encontrado.', 'success'); el.click(); resolve(el); return;
                }
                elapsed += 200;
                if (elapsed >= timeoutMs) { clearInterval(timer); reject(new Error('"' + label + '" nao apareceu')); }
            }, 200);
        });
    }

    // --- Bandeiras (tela flags) ---
    function extractAvailableFlags() {
        var flags = [];
        document.querySelectorAll('#flags_container .flag_box:not(.flag_box_empty), .flag_box:not(.flag_box_empty)').forEach(function (box) {
            var type, level;

            // Metodo 1: ID
            var m = (box.id || '').match(/flag_box_(\d+)_(\d+)/);
            if (m) { type = parseInt(m[1]); level = parseInt(m[2]); }

            // Metodo 2: background-image URL (.es / .it / outros servidores sem ID)
            if (!type) {
                var style = box.getAttribute('style') || '';
                var bm = style.match(/flags\/(?:[^/]*\/)?(\d+)_(\d+)\./);
                if (bm) { type = parseInt(bm[1]); level = parseInt(bm[2]); }
            }

            if (!type || !level) return;
            var countEl = box.querySelector('.flag_count');
            var count = countEl ? (parseInt(countEl.textContent.trim()) || 1) : 1;
            if (count < 1) return;
            flags.push({ type: type, level: level, count: count, category: FLAG_TYPE_MAP[type] || 'unknown',
                name: box.getAttribute('data-name') || '', title: box.getAttribute('data-title') || '', element: box });
        });
        return flags;
    }

    function isCurrentFlagAssigned() {
        var el = document.getElementById('current_flag');
        if (!el) return false;
        var style = el.getAttribute('style') || '';
        return !style.includes('display: none') && !style.includes('display:none');
    }

    function highlightBestFlag(element) {
        document.querySelectorAll('.tw-best-flag').forEach(function (el) { el.classList.remove('tw-best-flag'); el.style.outline = ''; el.style.boxShadow = ''; });
        element.classList.add('tw-best-flag');
        element.style.outline = '3px solid #2ecc71';
        element.style.boxShadow = '0 0 12px #2ecc71';
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function assignFlag(element) {
        element.click();
        return waitAndClick('#selected_flag .btn-confirm-yes', 'Ativar')
            .then(function () { return waitAndClick('button.evt-confirm-btn.btn-confirm-yes', 'Confirmar'); })
            .then(function () { log('Bandeira atribuida via DOM!', 'success'); HUD.set('flag', 'done', 'DOM click'); })
            .catch(function (e) { log('Falha DOM flag: ' + e.message, 'error'); });
    }

    function selectBestFlagGroq(flags, points, phase) {
        var payload = flags.map(function (f) { return { id: f.type + '_' + f.level, cat: f.category, name: f.name, level: f.level, qty: f.count }; });
        var prompt = 'Pick the BEST flag. Phase: ' + phase + ' (' + points + ' pts). Flags: ' + JSON.stringify(payload)
            + '. Reply ONLY with id like "3_4".';
        return gmGroq(prompt).then(function (content) {
            if (!content) return null;
            var m = content.match(/(\d+)_(\d+)/);
            if (!m) return null;
            var t = parseInt(m[1]), l = parseInt(m[2]);
            return flags.find(function (f) { return f.type === t && f.level === l; }) || null;
        });
    }

    function runFlagsMode() {
        log('Modo: Tela de Bandeiras (DOM)');
        var flags = extractAvailableFlags();
        if (!flags.length) { log('Nenhuma bandeira disponivel.', 'warning'); return; }
        var points = getVillagePoints();
        var phase = getGamePhase(points);
        var alreadyAssigned = isCurrentFlagAssigned();
        if (alreadyAssigned) { log('Bandeira ja atribuida.'); return; }

        selectBestFlagGroq(flags, points, phase).then(function (best) {
            if (!best) best = selectBestFlagLocal(flags, phase);
            if (!best) return;
            highlightBestFlag(best.element);
            if (CONFIG.autoAssignFlag) {
                HUD.set('flag', 'running', 'DOM: ' + best.name + ' Nv.' + best.level);
                setTimeout(function () { assignFlag(best.element); }, 1500);
            }
        });
    }

    // --- Estatua (tela main) ---
    function runMainMode() {
        log('Modo: Tela Principal (DOM)');
        var btn = document.querySelector('a.btn-build[data-building="statue"]');
        if (btn) {
            log('Construindo estatua via DOM...', 'success');
            HUD.set('statue', 'running', 'DOM click');
            btn.click();
            setTimeout(function () { HUD.set('statue', 'done', 'Clicado'); }, 1000);
        } else {
            log('Estatua nao disponivel para construir agora.');
        }
    }

    // --- Paladino (tela statue) ---
    function runStatueMode() {
        log('Modo: Tela da Estatua (DOM)');
        var selectors =['a.knight_recruit_launch', '.knight_recruit_launch', '#knight_recruit_launch', 'a[class*="recruit"]', 'button[class*="recruit"]'];
        var btn = null;
        for (var i = 0; i < selectors.length; i++) { btn = document.querySelector(selectors[i]); if (btn) break; }

        if (!btn) { log('Paladino ja recrutado ou indisponivel.'); HUD.set('knight', 'skip', 'Nao disponivel'); return; }

        HUD.set('knight', 'running', 'DOM click');
        btn.click();

        waitAndClick('#knight_recruit_confirm, .knight_recruit_confirm, .btn-confirm-yes', 'Confirmar recrutamento', 5000)
            .then(function () { return waitAndClick('.knight_recruit_rush', 'Termina gratis', 4000); })
            .then(function () { log('Paladino recrutado instantaneamente!', 'success'); HUD.set('knight', 'done', 'Instantaneo!'); })
            .catch(function () {
                var rush = document.querySelector('.knight_recruit_rush');
                if (rush) { rush.click(); HUD.set('knight', 'done', 'Instantaneo!'); }
                else { log('Recrutamento iniciado normalmente.', 'success'); HUD.set('knight', 'done', 'Iniciado'); }
            });
    }
    // ============================================================
    // INIT
    // ============================================================
    function init() {
        // Iframe do bot (knight e flag usam o mesmo name): o opener controla os cliques
        if (window.name === 'tw-bot-knight') {
            log('[init] Executando em iframe bot — skip auto actions');
            return;
        }
        log('TW Smart Automation v5.0 iniciado.');
        var villageId = getCurrentVillageId();
        var screen = getScreenParam();

        // Background checklist roda em QUALQUER tela
        if (villageId) {
            setTimeout(function () { runChecklist(villageId); }, CONFIG.checklistDelay);
        } else {
            // Sem village ID: mostra HUD vazio aguardando
            HUD.init();
        }

        // Modos de tela direta: feedback visual adicional quando usuario JA esta na tela
        // O checklist ja cuida da logica; os modos abaixo adicionam interacao DOM
        if (screen === 'flags') {
            var wait = setInterval(function () {
                if (document.getElementById('flags_container')) { clearInterval(wait); runFlagsMode(); }
            }, 200);
            setTimeout(function () { clearInterval(wait); }, 10000);

        } else if (screen === 'statue') {
            runStatueMode();

        } else if (screen === 'main') {
            setTimeout(runMainMode, 1000);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 800); });
    } else {
        setTimeout(init, 800);
    }

    window.TWBot = { config: CONFIG, hud: HUD };

})();
