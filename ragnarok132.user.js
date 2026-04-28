// ==UserScript==
// @name         Tribal Wars - Smart Automation
// @namespace    http://tampermonkey.net/
// @version      5.1
// @description  Checklist inteligente: bandeiras, estatua e paladino em segundo plano automaticamente
// @author       You
// @match        *://*.tribalwars.com.br/*
// @match        *://*.divoke-kmene.sk/*
// @match        *://*.guerrastribales.es/*
// @match        *://*.die-staemme.de/*
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
// @grant        unsafeWindow
// @connect      api.groq.com
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

   // ============================================================
    // CONFIG - VERSÃO TURBO (LOOP CONTÍNUO & RUSH GRÁTIS)
    // SEM IA PARA DECISÕES OPERACIONAIS
    // ============================================================
    var CONFIG = {
        debug: true,
        autoAssignFlag: true,
        autoRecruitKnight: true,
        autoBuildStatue: true,
        autoRushStatue: true,    // Finaliza estátua com ouro se disponível
        checklistDelay: 1000,    // Delay inicial reduzido para 1s

        // --- OTIMIZAÇÕES DE PERFORMANCE ---
        mainLoopInterval: 20000, // Ciclo padrão: 20s base + ±2s jitter para evitar sincronização
        freeRushMinutes: 3,      // Finaliza construções grátis se faltar menos de 3 minutos

        // Cache e debounce
        cacheExpiryMs: 5000,     // Cache expira em 5 segundos
        requestDebounceMs: 500,  // Debounce entre requisições

        // Paralelismo controlado
        maxConcurrentRequests: 3,// Máximo de requisições simultâneas

        // Batch processing
        processBatchSize: 5,     // Processar até 5 tarefas por ciclo

        // Modo Observação: analisa sem executar
        observationMode: GM_getValue('tw_obs_mode', false),

        // Configurações persistentes (carregadas do storage)
        autoUnlockScavenge: GM_getValue('tw_auto_unlock_scavenge', true) // DESBLOQUEIO AUTOMÁTICO DE COLETAS (ATIVADO POR PADRÃO)
    };

    // Cache system para evitar requisições redundantes
    var RequestCache = {
        _cache: {},
        _timestamps: {},
        _maxSize: 200, // limite máximo de entradas simultâneas

        get: function(key) {
            if (this._cache[key] && this._timestamps[key]) {
                var age = Date.now() - this._timestamps[key];
                if (age < CONFIG.cacheExpiryMs) {
                    return this._cache[key];
                } else {
                    delete this._cache[key];
                    delete this._timestamps[key];
                }
            }
            return null;
        },

        set: function(key, value) {
            // Evicção LRU: remove a entrada mais antiga se o limite for atingido
            var keys = Object.keys(this._cache);
            if (keys.length >= this._maxSize) {
                var oldest = keys.reduce(function(a, b) {
                    return (this._timestamps[a] || 0) < (this._timestamps[b] || 0) ? a : b;
                }.bind(this));
                delete this._cache[oldest];
                delete this._timestamps[oldest];
            }
            this._cache[key] = value;
            this._timestamps[key] = Date.now();
        },

        clear: function() {
            this._cache = {};
            this._timestamps = {};
        },

        // Limpeza de entradas expiradas (chamada periodicamente e em cada coleta)
        cleanup: function() {
            var now = Date.now();
            for (var key in this._timestamps) {
                if (now - this._timestamps[key] > CONFIG.cacheExpiryMs * 2) {
                    delete this._cache[key];
                    delete this._timestamps[key];
                }
            }
        }
    };

    // Rate limiter para controlar requisições simultâneas
    var RateLimiter = {
        _activeRequests: 0,
        _queue: [],

        acquire: function() {
            return new Promise((resolve) => {
                if (this._activeRequests < CONFIG.maxConcurrentRequests) {
                    this._activeRequests++;
                    resolve();
                } else {
                    this._queue.push(resolve);
                }
            });
        },

        release: function() {
            if (this._activeRequests <= 0) return;
            this._activeRequests--;
            if (this._queue.length > 0 && this._activeRequests < CONFIG.maxConcurrentRequests) {
                var next = this._queue.shift();
                this._activeRequests++;
                next();
            }
        }
    };
    // ============================================================
    // ============================================================
    // MÁQUINA DE ESTADOS RÍGIDA: CAMINHO CRÍTICO PARA LC (EARLY GAME)
    // Pesos não importam aqui. O que importa é o menor tempo para LC.
    // LC = Cavalaria Leve: carrega 80 recursos, anda rápido, custo-benefício máximo
    // ============================================================
    
    // Pré-requisitos do LC: Quartel 5, Estábulo 3, Ferreiro 5, HQ 10
    const LC_PATH_STATES = {
        // ESTADO 1: A BASE (0-500 pts)
        STATE_1_BASE: {
            id: 1,
            label: 'Estado 1: A Base (0-500 pts)',
            description: 'Fundações mínimas para começar',
            priority: 'CRITICAL',
            buildOrder: [
                { building: 'main', level: 3, reason: 'Bônus de velocidade' },
                { building: 'wood', level: 4, reason: 'Foco em Argila sempre!' },
                { building: 'stone', level: 4, reason: 'Suporte básico' },
                { building: 'iron', level: 3, reason: 'Mínimo necessário' },
                { building: 'main', level: 5, reason: 'Destrava Quartel' },
                { building: 'barracks', level: 1, reason: 'Primeiro quartel' },
                { building: 'farm', level: 2, reason: 'Para caber 10 lanceiros' }
            ],
            nextStates: ['STATE_2_PREP'],
            pointsRange: [0, 500]
        },
        
        // ESTADO 2: PREPARAÇÃO PARA O RUSH (500-1500 pts)
        // REGRA: NÃO SOBE FERREIRO AINDA. NÃO SOBE ESTÁTUA.
        STATE_2_PREP: {
            id: 2,
            label: 'Estado 2: Preparação para Rush (500-1500 pts)',
            description: 'Congelar minas no 10, focar em HQ e Quartel',
            priority: 'HIGH',
            rules: [
                'NÃO SUBIR FERREIRO AINDA',
                'NÃO SUBIR ESTÁTUA',
                'CONGELAR MINAS NO NÍVEL 10 (ROI péssimo depois do 10 no início)'
            ],
            buildOrder: [
                { building: 'wood', level: 10, reason: 'Congelar mina no 10' },
                { building: 'stone', level: 10, reason: 'Congelar mina no 10' },
                { building: 'iron', level: 10, reason: 'Congelar mina no 10' },
                { building: 'barracks', level: 5, reason: 'Pré-req do Estábulo' },
                { building: 'main', level: 10, reason: 'Acelera toda a árvore drasticamente' },
                { building: 'farm', level: 5, reason: 'Suporte de população' }
            ],
            nextStates: ['STATE_3_MILITARY_GATE'],
            pointsRange: [500, 1500]
        },
        
        // ESTADO 3: O GATE MILITAR (1500-2500 pts)
        // Aqui o bot sofre, pois gasta muito sem retorno imediato. Mas é necessário.
        STATE_3_MILITARY_GATE: {
            id: 3,
            label: 'Estado 3: O Gate Militar (1500-2500 pts)',
            description: 'Investimento pesado sem retorno imediato - NECESSÁRIO',
            priority: 'CRITICAL',
            rules: [
                'GASTO ALTO SEM RETORNO IMEDIATO - MAS NECESSÁRIO',
                'SUBIR FERREIRO APENAS AGORA!'
            ],
            buildOrder: [
                { building: 'stable', level: 3, reason: 'Pré-req do LC' },
                { building: 'smith', level: 5, reason: 'Subir o Smith apenas agora!' },
                { building: 'farm', level: 7, reason: 'Aguentar custo pop do Estábulo' }
            ],
            unlockCondition: {
                stable: 3,
                smith: 5,
                farm: 7,
                barracks: 5,
                main: 10
            },
            unlocksUnit: 'light_cavalry', // LC DESBLOQUEADO!
            nextStates: ['STATE_4_POST_LC_SCALE'],
            pointsRange: [1500, 2500]
        },
        
        // ESTADO 4: ESCALA PÓS-LC (2500+ pts)
        // Agora o saque paga a conta. O bot volta a focar em ROI.
        STATE_4_POST_LC_SCALE: {
            id: 4,
            label: 'Estado 4: Escala Pós-LC (2500+ pts)',
            description: 'Saque paga a conta - Volta a focar em ROI',
            priority: 'NORMAL',
            rules: [
                'COMEÇAR A RECRUTAR LC 24/7',
                'SAQUE PAGA A CONTA',
                'VOLTA A FOCAR EM ROI'
            ],
            buildOrder: [
                { building: 'stable', level: 10, reason: 'Mais LC' },
                { building: 'smith', level: 10, reason: 'Melhorias militares' },
                { building: 'barracks', level: 10, reason: 'Suporte de infantaria' },
                { building: 'farm', level: 10, reason: 'População para exército' }
            ],
            recruitmentPriority: ['light_cavalry'],
            pointsRange: [2500, Infinity]
        }
    };

    // ESTRATÉGIAS DE CRESCIMENTO (Pesos de 1 a 10)
    // ============================================================
    var STRATEGIES = {
        'BALANCED':           { wood: 8, stone: 8, iron: 7, storage: 6, main: 5, farm: 5, barracks: 4, wall: 3, smith: 3, stable: 2 },
        'ECONOMY':            { wood: 10, stone: 10, iron: 9, storage: 7, main: 6, farm: 5, market: 3, wall: 1 },
        'MILITARY':           { barracks: 10, stable: 8, smith: 7, farm: 9, iron: 7, wood: 5, stone: 5, wall: 6, main: 5 },
        // ── Perfis agressivos ──
        // Speed Start: máxima velocidade de pontos — HQ primeiro, sempre
        'SPEED_START':        { main: 10, farm: 8, barracks: 7, storage: 6, wood: 6, stone: 6, iron: 5, statue: 5, smith: 4, wall: 2 },
        // Fake Farm: quartel cedo para lançadores de lança baratos, ferro em foco
        'FAKE_FARM':          { barracks: 10, iron: 9, farm: 8, wood: 7, stone: 6, main: 5, storage: 5, smith: 4, wall: 2, stable: 1 },
        // Hard Military Rush: ofensiva pura — ferro + quartel + estábulo + ferreiro o mais rápido possível
        'HARD_MILITARY_RUSH': { iron: 10, barracks: 10, stable: 9, smith: 8, farm: 9, wood: 5, stone: 4, main: 5, wall: 6, storage: 4 },
        // LC RUSH: Máquina de estados rígida para Cavalaria Leve o mais rápido possível
        'LC_RUSH':            { main: 10, farm: 9, barracks: 10, iron: 8, stable: 10, smith: 8, wood: 6, stone: 6, storage: 4, wall: 2, statue: 1 }
    };




    // ============================================================
    // ROADMAP / MARCOS ESTRATÉGICOS (METAS DO JOGO)
    // ============================================================
    // Milestones globais: fundações universais que toda aldeia constrói primeiro
    const MILESTONES_GLOBAL = [
        { id: 'unlock_statue',   label: 'Erigir Estátua',       reqs: { statue: 1 } },
        { id: 'hq_early',        label: 'HQ Nv 5',              reqs: { main: 5 } },
        { id: 'unlock_barracks', label: 'Quartel de Tropa',      reqs: { barracks: 1 } },
        { id: 'unlock_smith',    label: 'Caminho do Ferreiro',   reqs: { smith: 1 } },
        { id: 'hq_mid',          label: 'HQ Nv 10',             reqs: { main: 10 } },
        { id: 'unlock_stable',   label: 'Desbloqueio Estábulo', reqs: { stable: 1 } },
        { id: 'quartel_base',    label: 'Quartel Base',         reqs: { barracks: 5 } },
    ];

    // Milestones por perfil: roadmap divergente após as fundações globais
    const MILESTONES_BY_PROFILE = {
        // Aldeia econômica: maximizar produção de recursos e capacidade de armazém
        economic: [
            { id: 'eco_base',     label: 'Base Econômica',     reqs: { wood: 10, stone: 10, iron: 8 } },
            { id: 'eco_market',   label: 'Mercado Ativo',      reqs: { market: 5, storage: 8 } },
            { id: 'eco_scale',    label: 'Escala Econômica',   reqs: { wood: 15, stone: 15, iron: 15 } },
            { id: 'eco_advanced', label: 'Economia Avançada',  reqs: { wood: 20, stone: 20, iron: 18, storage: 15 } },
        ],
        // Aldeia militar: capacidade ofensiva — estábulo, ferreiro e quartel em foco
        military: [
            { id: 'mil_stable',     label: 'Desbloqueio Estábulo', reqs: { stable: 1 } },
            { id: 'mil_smith10',    label: 'Ferreiro Nv 10',       reqs: { smith: 10 } },
            { id: 'mil_barracks10', label: 'Quartel Nv 10',        reqs: { barracks: 10, stable: 5 } },
            { id: 'mil_wall',       label: 'Muralha Defensiva',    reqs: { wall: 10 } },
            { id: 'mil_full',       label: 'Arsenal Completo',     reqs: { barracks: 20, stable: 15, smith: 20 } },
        ],
        // Aldeia support: muralha alta, igreja, storage — resistência máxima
        support: [
            { id: 'sup_wall10',   label: 'Muralha Nv 10',       reqs: { wall: 10 } },
            { id: 'sup_church',   label: 'Igreja Ativa',         reqs: { church: 1 } },
            { id: 'sup_storage',  label: 'Storage Ampliado',     reqs: { storage: 15 } },
            { id: 'sup_wall20',   label: 'Muralha Máxima',       reqs: { wall: 20 } },
        ],
        // Aldeia balanced: desenvolvimento completo com noble prep como endgame
        balanced: [
            { id: 'bal_eco_base',  label: 'Base Econômica',    reqs: { wood: 10, stone: 10, iron: 8 } },
            { id: 'bal_stable',    label: 'Estábulo',          reqs: { stable: 1 } },
            { id: 'bal_eco15',     label: 'Escala Econômica',  reqs: { wood: 15, stone: 15, iron: 15 } },
            { id: 'bal_market10',  label: 'Mercado Ativo',     reqs: { market: 10 } },
            { id: 'bal_eco20',     label: 'Minas Avançadas',   reqs: { wood: 20, stone: 20, iron: 18 } },
            { id: 'noble_prep',    label: 'Preparo Academia',  reqs: { main: 20, smith: 20, market: 10 } },
        ],
        // Speed Start: chegar a 1000 pontos o mais rápido possível — HQ em foco
        speed_start: [
            { id: 'spd_hq5',      label: 'HQ Nv 5',           reqs: { main: 5 } },
            { id: 'spd_barracks', label: 'Quartel Desbloq.',   reqs: { barracks: 1 } },
            { id: 'spd_statue',   label: 'Estátua Erguida',    reqs: { statue: 1 } },
            { id: 'spd_hq10',     label: 'HQ Nv 10',          reqs: { main: 10 } },
            { id: 'spd_farm5',    label: 'Fazenda Nv 5',      reqs: { farm: 5 } },
            { id: 'spd_eco_base', label: 'Recursos Base',     reqs: { wood: 8, stone: 8, iron: 6 } },
            { id: 'spd_1k',       label: 'Milestone 1k Pts',  reqs: { main: 15, barracks: 5, storage: 6, farm: 8 } },
        ],
        // Fake Farm: produzir lanceiros baratos e farmar aldeias inativas
        fake_farm: [
            { id: 'ff_barracks3',  label: 'Quartel Nv 3',     reqs: { barracks: 3 } },
            { id: 'ff_iron8',      label: 'Mina Ferro Nv 8',  reqs: { iron: 8 } },
            { id: 'ff_farm10',     label: 'Fazenda Nv 10',    reqs: { farm: 10 } },
            { id: 'ff_barracks10', label: 'Quartel Nv 10',    reqs: { barracks: 10 } },
            { id: 'ff_wood8',      label: 'Serra Nv 8',       reqs: { wood: 8 } },
            { id: 'ff_full_farm',  label: 'Farm Máximo',      reqs: { barracks: 15, iron: 12, farm: 15 } },
        ],
        // Hard Military Rush: máxima ofensiva — ferro + quartel + estábulo + ferreiro o mais rápido possível
        hard_military_rush: [
            { id: 'hmr_iron8',      label: 'Ferro Nv 8',         reqs: { iron: 8 } },
            { id: 'hmr_barracks5',  label: 'Quartel Nv 5',       reqs: { barracks: 5 } },
            { id: 'hmr_stable1',    label: 'Estábulo Desbloq.',  reqs: { stable: 1 } },
            { id: 'hmr_smith10',    label: 'Ferreiro Nv 10',     reqs: { smith: 10 } },
            { id: 'hmr_barracks10', label: 'Quartel Nv 10',      reqs: { barracks: 10 } },
            { id: 'hmr_farm12',     label: 'Fazenda Nv 12',      reqs: { farm: 12 } },
            { id: 'hmr_full',       label: 'Arsenal Ofensivo',   reqs: { barracks: 20, stable: 15, smith: 20, iron: 15 } },
        ],
    };

    var FLAG_TYPE_MAP = {
        1: 'resource', 2: 'recruitment', 3: 'attack',
        4: 'defense', 5: 'luck', 6: 'population', 7: 'coin', 8: 'loot',
    };

    var CATEGORY_PRIORITY = {
        EARLY: { resource: 100, population: 80, recruitment: 60, attack: 50, defense: 40, loot: 30, luck: 20, coin: 10 },
        MID:   { attack: 100, loot: 90, recruitment: 80, resource: 70, population: 60, defense: 50, luck: 40, coin: 30 },
        LATE:  { attack: 100, loot: 95, coin: 80, recruitment: 70, resource: 60, population: 50, defense: 40, luck: 30 },
    };

    // Pesos por perfil de aldeia — decisor primário (fase atua como modulador secundário ±20%)
    var CATEGORY_PRIORITY_BY_PROFILE = {
        economic:           { resource: 100, population: 85, loot: 55, recruitment: 35, attack: 25, defense: 20, luck: 10, coin: 15 },
        military:           { attack: 100, recruitment: 95, loot: 85, defense: 55, resource: 40, population: 30, luck: 20, coin: 10 },
        support:            { defense: 100, population: 90, resource: 55, recruitment: 30, attack: 15, loot: 20, luck: 10, coin: 10 },
        balanced:           { resource: 75, attack: 70, recruitment: 65, loot: 60, population: 60, defense: 50, luck: 20, coin: 10 },
        // ── Perfis agressivos ──
        speed_start:        { resource: 90, population: 95, recruitment: 60, attack: 40, defense: 20, loot: 30, luck: 25, coin: 15 },
        fake_farm:          { loot: 100, recruitment: 90, attack: 80, resource: 65, population: 75, defense: 20, luck: 30, coin: 10 },
        hard_military_rush: { attack: 100, recruitment: 100, loot: 70, resource: 35, population: 60, defense: 45, luck: 20, coin: 10 },
    };

    // ============================================================
    // CUSTOS DE EDIFÍCIOS (BASE TW 10.x - AJUSTÁVEL POR MUNDO)
    // Formato: [madeira, pedra, ferro, tempo_segundos]
    // ============================================================
    // Custos base de edifícios: [madeira, pedra, ferro, tempo_segundos] no nível 1 (de 0→1).
    // Estes são PADRÕES e variam por mundo/versão. Sobrescreva via window.TWBot.setCostOverride()
    // ou GM_setValue('twbot_costs_override', JSON.stringify({barracks:[90,130,0,130], ...})).
    var TW_BUILDING_COSTS = {
        main:       [20, 40, 0, 60],
        barracks:   [80, 120, 0, 120],
        church:     [300, 500, 0, 300],
        watchtower: [150, 200, 0, 180],
        stable:     [200, 300, 150, 240],
        garage:     [400, 500, 300, 300],
        snob:       [60000, 60000, 60000, 3600],
        smith:      [100, 150, 50, 150],
        place:      [50, 100, 0, 90],
        statue:     [500, 500, 500, 600],
        market:     [100, 100, 50, 120],
        wood:       [50, 0, 0, 60],
        stone:      [0, 50, 0, 60],
        iron:       [0, 0, 50, 60],
        farm:       [70, 90, 0, 90],
        storage:    [100, 100, 0, 90],
        hide:       [150, 0, 100, 150],
        wall:       [100, 150, 0, 180]
    };
    (function _loadCostOverrides() {
        try {
            // Chave de contexto: mundo + mercado + idioma para calibração precisa
            var _wId    = (typeof game_data !== 'undefined' && game_data.world)
                ? game_data.world
                : window.location.hostname.replace(/[^a-z0-9]/gi, '_');
            var _market = (typeof game_data !== 'undefined' && game_data.market) || 'unk';
            var _lang   = (document.documentElement.lang || navigator.language || 'unk').split('-')[0].toLowerCase();
            var _ctxKey = (_wId + '_' + _market + '_' + _lang).replace(/[^a-z0-9_]/gi, '_');

            // 1. Custos auto-calibrados por contexto (scraping DOM) — prioridade base
            var scrapedRaw = GM_getValue('twbot_costs_data_' + _ctxKey, null);
            if (scrapedRaw) {
                var scrapedData = typeof scrapedRaw === 'string' ? JSON.parse(scrapedRaw) : scrapedRaw;
                for (var bs in scrapedData) {
                    if (Array.isArray(scrapedData[bs])) TW_BUILDING_COSTS[bs] = scrapedData[bs];
                }
                log('[costs] Custos calibrados para contexto "' + _ctxKey + '" carregados', 'info');
            }

            // 2. Overrides manuais sobrescrevem tudo (maior prioridade)
            var raw = GM_getValue('twbot_costs_override', null);
            if (!raw) return;
            var overrides = typeof raw === 'string' ? JSON.parse(raw) : raw;
            var applied = [];
            for (var b in overrides) {
                if (Array.isArray(overrides[b]) && overrides[b].length >= 3) {
                    TW_BUILDING_COSTS[b] = overrides[b];
                    applied.push(b);
                }
            }
            if (applied.length) log('[costs] Overrides manuais aplicados: ' + applied.join(', '), 'info');
        } catch (e) { log('[costs] Erro ao carregar overrides: ' + e.message, 'warning'); }
    })();

    // Chave de contexto para calibração de custos por mundo + mercado + idioma
    function getCostContextKey(worldId) {
        var market = 'unk';
        var lang   = 'unk';
        try {
            market = (typeof game_data !== 'undefined' && game_data.market) || 'unk';
            lang   = (document.documentElement.lang || navigator.language || 'unk').split('-')[0].toLowerCase();
        } catch(e) {}
        return (worldId + '_' + market + '_' + lang).replace(/[^a-z0-9_]/gi, '_');
    }

    // Fatores de peso estratégico por fase e tipo de edifício
    const STRATEGIC_WEIGHT = {
        EARLY: { wood: 1.8, stone: 1.8, iron: 1.4, farm: 1.6, storage: 1.1, main: 0.7, barracks: 1.0, smith: 2.2, statue: 1.2, market: 1.7, stable: 2.0, wall: 0.4, place: 0.5, hide: 0.3, church: 0.3, watchtower: 0.3, garage: 0.2, snob: 0.1 },
        MID:   { wood: 1.0, stone: 1.0, iron: 1.1, farm: 1.1, storage: 1.0, main: 1.8, barracks: 1.1, smith: 1.2, statue: 1.0, market: 0.9, stable: 1.3, wall: 1.1, place: 0.6, hide: 0.5, church: 0.7, watchtower: 0.6, garage: 0.8, snob: 0.3 },
        LATE:  { wood: 0.8, stone: 0.8, iron: 1.2, farm: 0.9, storage: 0.9, main: 2.0, barracks: 1.0, smith: 1.3, statue: 1.1, market: 1.0, stable: 1.2, wall: 1.3, place: 0.7, hide: 0.6, church: 0.9, watchtower: 0.8, garage: 1.0, snob: 1.5 }
    };

    // Bônus do HQ como multiplicador de produtividade (acelera TODAS as construções)
    const HQ_PRODUCTIVITY_BONUS = {
        1: 0.04, 2: 0.08, 3: 0.12, 4: 0.16, 5: 0.21,  // +21% aos 5 — rush early agressivo
        6: 0.25, 7: 0.28, 8: 0.31, 9: 0.34, 10: 0.38, // +38% aos 10 (marco hq_mid)
        11: 0.41, 12: 0.44, 13: 0.47, 14: 0.50, 15: 0.53,
        16: 0.55, 17: 0.57, 18: 0.59, 19: 0.61, 20: 0.63,
        21: 0.65, 22: 0.67, 23: 0.68, 24: 0.69, 25: 0.70  // +70% no máximo
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
            actionLock: 'village_action_lock_',
            villageProfile: 'village_profile_'
        },

        // Duração dos cooldowns em ms
        COOLDOWNS: {
            BUILD_FAIL: 300000,      // 5 minutos após falha de construção
            TARGET_BLOCK: 600000,    // 10 minutos para targets problemáticos
            ACTION_LOCK: 30000,      // 30 segundos — TTL de segurança do lock (expira sozinho após crash/reload)
            SOFT_RESET: 1800000      // 30 minutos para reset suave
        },

        // Perfis de aldeia
        PROFILES: {
            ECONOMIC:           'economic',           // Foco em recursos e storage
            MILITARY:           'military',           // Foco em tropas e ofensiva
            SUPPORT:            'support',            // Foco em defesa e suporte
            BALANCED:           'balanced',           // Equilibrado (auto-detectável)
            // ── Perfis agressivos (manuais — não sobrescritos por auto-detecção) ──
            SPEED_START:        'speed_start',        // Rush 1000 pontos — HQ prioritário
            FAKE_FARM:          'fake_farm',          // Lanceiros baratos + farm de inativos
            HARD_MILITARY_RUSH: 'hard_military_rush', // Ofensiva pura: ferro + quartel + estábulo
            LC_RUSH:            'lc_rush',            // Caminho crítico para Cavalaria Leve
        },

        // Desserializa valor que pode ter sido salvo como JSON string
        _load: function(key, fallback) {
            var v = GM_getValue(key, null);
            if (v === null || v === undefined) return fallback;
            if (typeof v === 'string') {
                try { return JSON.parse(v); } catch (e) { return fallback; }
            }
            return v;
        },

        // Obter memória completa de uma aldeia
        get: function(villageId) {
            var lockVal = GM_getValue(this.KEYS.actionLock + villageId, 0);
            return {
                lastTarget:          GM_getValue(this.KEYS.lastTarget          + villageId, null),
                lastSuccess:         GM_getValue(this.KEYS.lastSuccess         + villageId, null),
                lastError:           this._load(this.KEYS.lastError            + villageId, null),
                cooldownUntil:       GM_getValue(this.KEYS.cooldownUntil       + villageId, 0),
                previousBottleneck:  GM_getValue(this.KEYS.previousBottleneck  + villageId, null),
                currentMilestone:    GM_getValue(this.KEYS.currentMilestone    + villageId, null),
                consecutiveFails:    GM_getValue(this.KEYS.consecutiveFails    + villageId, 0),
                blockedTargets:      this._load(this.KEYS.blockedTargets        + villageId, {}),
                // actionLock armazena timestamp de expiração (0 = livre)
                actionLock:          (typeof lockVal === 'number' ? lockVal : (lockVal ? Date.now() + VillageMemory.COOLDOWNS.ACTION_LOCK : 0)),
                profile:             GM_getValue(this.KEYS.villageProfile      + villageId, this.PROFILES.BALANCED)
            };
        },

        // Definir perfil da aldeia
        setProfile: function(villageId, profile) {
            if (this.PROFILES[profile.toUpperCase()]) {
                this.set(villageId, 'villageProfile', this.PROFILES[profile.toUpperCase()]);
                log('[memória] Perfil definido: ' + profile, 'info');
            }
        },

        // Obter pesos estratégicos baseados no perfil da aldeia
        getStrategyWeights: function(villageId) {
            var mem = this.get(villageId);
            var profile = mem.profile || this.PROFILES.BALANCED;

            // Pesos por tipo de edifício para cada perfil
            var weights = {
                economic:           { wood: 1.5, stone: 1.5, iron: 1.4, storage: 1.3, farm: 1.2, main: 1.1, barracks: 0.6, stable: 0.5, smith: 0.7, wall: 0.5, place: 0.4, hide: 0.3, church: 0.3, statue: 0.8, market: 1.2, garage: 0.3, snob: 0.4 },
                military:           { wood: 0.8, stone: 0.8, iron: 1.3, storage: 0.9, farm: 1.4, main: 1.0, barracks: 1.5, stable: 1.4, smith: 1.3, wall: 1.1, place: 0.6, hide: 0.4, church: 0.3, statue: 1.0, market: 0.5, garage: 0.8, snob: 0.6 },
                support:            { wood: 0.9, stone: 0.9, iron: 1.0, storage: 1.0, farm: 1.1, main: 1.0, barracks: 0.8, stable: 0.7, smith: 0.9, wall: 1.5, place: 0.5, hide: 0.6, church: 1.2, statue: 1.1, market: 0.7, garage: 0.5, snob: 0.3 },
                balanced:           { wood: 1.2, stone: 1.2, iron: 1.1, storage: 1.0, farm: 1.2, main: 1.3, barracks: 1.0, stable: 0.9, smith: 1.0, wall: 0.9, place: 0.5, hide: 0.4, church: 0.5, statue: 0.9, market: 0.7, garage: 0.6, snob: 0.5 },
                // ── Perfis agressivos ──
                // Speed Start: HQ domina para acelerar todas as obras e pontuar rápido
                speed_start:        { wood: 1.1, stone: 1.1, iron: 1.0, storage: 1.1, farm: 1.3, main: 2.0, barracks: 1.2, stable: 0.4, smith: 0.7, wall: 0.3, place: 0.5, hide: 0.3, church: 0.3, statue: 1.5, market: 0.6, garage: 0.3, snob: 0.3 },
                // Fake Farm: quartel + ferro para produzir lanceiros baratos sem parar
                fake_farm:          { wood: 1.0, stone: 0.9, iron: 1.8, storage: 0.9, farm: 1.6, main: 0.9, barracks: 2.0, stable: 0.5, smith: 0.9, wall: 0.4, place: 0.6, hide: 0.3, church: 0.3, statue: 0.9, market: 0.5, garage: 0.3, snob: 0.3 },
                // Hard Military Rush: ferro e tropas ofensivas em foco máximo
                hard_military_rush: { wood: 0.7, stone: 0.6, iron: 2.0, storage: 0.7, farm: 1.5, main: 0.8, barracks: 2.0, stable: 1.8, smith: 1.7, wall: 1.0, place: 0.6, hide: 0.3, church: 0.3, statue: 0.9, market: 0.4, garage: 0.6, snob: 0.4 },
            };

            return weights[profile] || weights.balanced;
        },

        // Atualizar campo específico
        set: function(villageId, field, value) {
            var key = this.KEYS[field] + villageId;
            // Serialização explícita para compatibilidade com Greasemonkey/Violentmonkey
            var toStore = (value !== null && typeof value === 'object') ? JSON.stringify(value) : value;
            GM_setValue(key, toStore);
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
            this.set(villageId, 'lastError', { target: target, type: errorType, time: Date.now() });
            this.set(villageId, 'actionLock', false);

            // no_resources = recursos insuficientes, não é falha real do servidor — não bloqueia target
            if (errorType === 'no_resources') return;

            var fails = (mem.consecutiveFails || 0) + 1;
            this.set(villageId, 'consecutiveFails', fails);
            this.set(villageId, 'cooldownUntil', Date.now() + this.COOLDOWNS.BUILD_FAIL);

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

        // Limpar bloqueios e contagem de falhas (use no console ou ao detectar falso positivo)
        resetBlockedTargets: function(villageId) {
            GM_setValue('village_blocked_targets_' + villageId, '{}');
            GM_setValue('village_consecutive_fails_' + villageId, 0);
            log('[memória] Bloqueios e falhas resetados para aldeia ' + villageId, 'success');
        },

        // Verificar se target está bloqueado
        isTargetBlocked: function(villageId, target) {
            var mem = this.get(villageId);
            var blocked = mem.blockedTargets || {};
            if (blocked[target] && Date.now() < blocked[target]) {
                return true;
            }
            // Limpar expirados — usa cópia para comparação correta de tamanho
            var originalLength = Object.keys(blocked).length;
            for (var t in blocked) {
                if (Date.now() >= blocked[t]) {
                    delete blocked[t];
                }
            }
            if (Object.keys(blocked).length < originalLength) {
                this.set(villageId, 'blockedTargets', blocked);
            }
            return false;
        },

        // Verificar se pode executar ação (actionLock com TTL + cooldown)
        canAct: function(villageId) {
            var mem = this.get(villageId);
            var now = Date.now();

            // actionLock é um timestamp de expiração: 0 = livre, >now = travado
            if (mem.actionLock && now < mem.actionLock) {
                log('[memória] ActionLock ativo por mais ' + Math.round((mem.actionLock - now)/1000) + 's', 'warning');
                return false;
            }

            // Lock expirado — limpa automaticamente (proteção contra travamento por reload)
            if (mem.actionLock && now >= mem.actionLock) {
                GM_setValue(this.KEYS.actionLock + villageId, 0);
            }

            // Verificar cooldown global
            if (mem.cooldownUntil && now < mem.cooldownUntil) {
                log('[memória] Em cooldown por ' + Math.round((mem.cooldownUntil - now)/1000) + 's', 'warning');
                return false;
            }

            return true;
        },

        // Adquirir lock de ação (TTL = COOLDOWNS.ACTION_LOCK — expira sozinho se a página recarregar)
        acquireLock: function(villageId) {
            if (this.canAct(villageId)) {
                GM_setValue(this.KEYS.actionLock + villageId, Date.now() + this.COOLDOWNS.ACTION_LOCK);
                return true;
            }
            return false;
        },

        // Liberar lock de ação
        releaseLock: function(villageId) {
            GM_setValue(this.KEYS.actionLock + villageId, 0);
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
                // FIX: atualiza lastSuccess para evitar re-trigger a cada ciclo (loop infinito)
                this.set(villageId, 'lastSuccess', Date.now());
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
    function getVillageIdParam() {
        var id = new URL(window.location.href).searchParams.get('village');
        return (id && /^\d+$/.test(id)) ? id : null;
    }
    function getVillagePoints() {
        try { return parseInt((typeof game_data !== 'undefined' && game_data.village && game_data.village.points) || 0) || 0; } catch (e) { return 0; }
    }
    function getGamePhase(pts) { return pts < 500 ? 'EARLY' : pts < 5000 ? 'MID' : 'LATE'; }
    function getCurrentVillageId() {
        return getVillageIdParam()
            || (typeof game_data !== 'undefined' && game_data.village && game_data.village.id
                ? String(game_data.village.id)
                : null);
    }
    // Canonicaliza qualquer forma de ID (número, string, undefined) para string numérica ou null.
    // Todas as funções públicas devem chamar isso na entrada.
    function normalizeVillageId(id) {
        if (id === null || id === undefined || id === '') return null;
        var s = String(id).trim();
        return /^\d+$/.test(s) ? s : null;
    }

    // ============================================================
    // HTTP - APENAS PARA OPERAÇÕES LOCAIS DO JOGO
    // SEM CHAMADAS EXTERNAS PARA IA
    // COM CACHE E RATE LIMITING PARA PERFORMANCE
    // ============================================================
    function gmGet(url, useCache) {
        // Verifica cache se habilitado
        if (useCache !== false) {
            var cached = RequestCache.get('gmGet:' + url);
            if (cached) {
                return Promise.resolve(cached);
            }
        }

        return RateLimiter.acquire().then(function() {
            return new Promise(function (resolve, reject) {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url.startsWith('http') ? url : window.location.origin + url,
                    headers: { 'X-Requested-With': 'XMLHttpRequest' },
                    onload: function (r) {
                        RateLimiter.release();
                        if (useCache !== false) {
                            RequestCache.set('gmGet:' + url, r.responseText);
                        }
                        resolve(r.responseText);
                    },
                    onerror: function () {
                        RateLimiter.release();
                        reject(new Error('GET falhou: ' + url));
                    },
                });
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
    // Com rate limiting (slot adquirido antes do disparo) e debounce por tempo real entre disparos
    var twFetchLastCall = 0;

    function twFetch(url, method, body, useCache) {
        // Verifica cache para GET requests (retorna imediatamente, sem consumir slot)
        if (method === 'GET' && useCache !== false) {
            var cached = RequestCache.get('twFetch:' + url + ':' + (body || ''));
            if (cached) return Promise.resolve(cached);
        }

        return RateLimiter.acquire().then(function() {
            // Debounce calculado no momento do disparo real (não no enfileiramento)
            var now = Date.now();
            var debounceNeeded = CONFIG.requestDebounceMs - (now - twFetchLastCall);
            twFetchLastCall = now;

            var win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
            var opts = {
                method: method || 'GET',
                credentials: 'include',
                headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                    'Accept': 'application/json, text/javascript, */*; q=0.01'
                },
            };
            if (body) {
                opts.headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
                opts.body = body;
            }

            var dispatch = function() {
                return win.fetch(url, opts).then(function(r) {
                    return r.text().then(function(text) {
                        RateLimiter.release();
                        // Status 500 com redirect é resposta normal do TW para algumas ações AJAX
                        // (confirma execução e pede redirecionamento de tela) — não é erro fatal
                        if (r.status === 500 && text.indexOf('"redirect"') !== -1) {
                            return text;
                        }
                        if (method === 'GET' && useCache !== false && r.status === 200) {
                            RequestCache.set('twFetch:' + url + ':' + (body || ''), text);
                        }
                        return text;
                    }, function(textErr) {
                        RateLimiter.release();
                        throw textErr;
                    });
                }, function(fetchErr) {
                    RateLimiter.release();
                    log('[twFetch] ERRO: ' + fetchErr.message, 'error');
                    throw fetchErr;
                });
            };

            if (debounceNeeded > 0) {
                return new Promise(function(resolve) { setTimeout(resolve, debounceNeeded); }).then(dispatch);
            }
            return dispatch();
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
        obsMode: GM_getValue('tw_obs_mode', false),
        obsReport: null,

        // Mapeamento de perfis para labels amigáveis no HUD
        GOAL_LABELS: {
            speed_start:        { icon: '🚀', label: 'Crescer Rápido' },
            hard_military_rush: { icon: '⚔️', label: 'Ataque' },
            fake_farm:          { icon: '🌾', label: 'Farm' },
            support:            { icon: '🛡️', label: 'Defesa' },
            economic:           { icon: '💰', label: 'Economia' },
            balanced:           { icon: '⚖️', label: 'Auto' },
        },

        // Candidatos da última decisão (populados por motorDeDecisaoMacro)
        candidates:    [],
        forcedTarget:  null,
        pinnedBuilding: GM_getValue('tw_hud_pin', null),
        // Máquina de estados do pin: ACTIVE, COOLING, FAILED
        pinState: GM_getValue('tw_hud_pin_state', 'ACTIVE'),
        pinFailCount: GM_getValue('tw_hud_pin_fails', 0),
        pinCooldownUntil: GM_getValue('tw_hud_pin_cooldown', 0),

        setCandidates: function(list) {
            this.candidates = list || [];
            this._rerender();
        },

        setForced: function(building) {
            this.forcedTarget = building;
            log('[HUD] Override one-shot agendado: ' + building, 'warning');
        },

        setPin: function(building) {
            if (this.pinnedBuilding === building) {
                this.pinnedBuilding = null;
                this.pinState = 'ACTIVE';
                this.pinFailCount = 0;
                this.pinCooldownUntil = 0;
                GM_deleteValue('tw_hud_pin');
                GM_deleteValue('tw_hud_pin_state');
                GM_deleteValue('tw_hud_pin_fails');
                GM_deleteValue('tw_hud_pin_cooldown');
                log('[HUD] 📌 Pin removido', 'info');
            } else {
                this.pinnedBuilding = building;
                this.pinState = 'ACTIVE';
                this.pinFailCount = 0;
                this.pinCooldownUntil = 0;
                GM_setValue('tw_hud_pin', building);
                GM_setValue('tw_hud_pin_state', 'ACTIVE');
                GM_setValue('tw_hud_pin_fails', 0);
                GM_setValue('tw_hud_pin_cooldown', 0);
                log('[HUD] 📌 ' + building + ' fixado como próxima construção', 'warning');
            }
            this._rerender();
        },

        // Atualizar estado do pin baseado em bloqueios
        updatePinState: function() {
            if (!this.pinnedBuilding) return;
            
            var now = Date.now();
            
            // Se estiver em COOLING e cooldown expirou, volta para ACTIVE
            if (this.pinState === 'COOLING' && now >= this.pinCooldownUntil) {
                this.pinState = 'ACTIVE';
                this.pinFailCount = 0;
                this.pinCooldownUntil = 0;
                GM_setValue('tw_hud_pin_state', 'ACTIVE');
                GM_setValue('tw_hud_pin_fails', 0);
                GM_setValue('tw_hud_pin_cooldown', 0);
                log('[HUD] 📌 Pin voltou ao estado ACTIVE', 'info');
            }
            
            // Se estiver em FAILED por 3+ bloqueios, auto-libera o pin
            if (this.pinFailCount >= 3) {
                this.pinState = 'FAILED';
                GM_setValue('tw_hud_pin_state', 'FAILED');
                log('[HUD] 📌 Pin em estado FAILED após ' + this.pinFailCount + ' bloqueios consecutivos - auto-liberando', 'warning');
                this.setPin(null); // Remove o pin
            }
        },

        // Registrar bloqueio do pin
        recordPinBlock: function() {
            if (!this.pinnedBuilding) return;
            
            this.pinFailCount++;
            GM_setValue('tw_hud_pin_fails', this.pinFailCount);
            
            if (this.pinFailCount < 3) {
                this.pinState = 'COOLING';
                this.pinCooldownUntil = Date.now() + 600000; // 10 minutos
                GM_setValue('tw_hud_pin_state', 'COOLING');
                GM_setValue('tw_hud_pin_cooldown', this.pinCooldownUntil);
                log('[HUD] 📌 Pin entrou em COOLING (bloqueio #' + this.pinFailCount + ')', 'warning');
            } else {
                this.pinState = 'FAILED';
                GM_setValue('tw_hud_pin_state', 'FAILED');
                log('[HUD] 📌 Pin entrou em FAILED (bloqueio #' + this.pinFailCount + ') - auto-liberando', 'warning');
                this.setPin(null); // Remove o pin
            }
            this._rerender();
        },

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
            quest: { label: 'Quests', status: 'idle', detail: '' },
            build_general: { label: 'Obras', status: 'idle', detail: '' },
            scavenge: { label: 'Coletas', status: 'idle', detail: '' }
        },

        toggleObsMode: function () {
            this.obsMode = !this.obsMode;
            CONFIG.observationMode = this.obsMode;
            GM_setValue('tw_obs_mode', this.obsMode);
            this._rerender();
        },

        toggleScavengeUnlock: function () {
            CONFIG.autoUnlockScavenge = !CONFIG.autoUnlockScavenge;
            GM_setValue('tw_auto_unlock_scavenge', CONFIG.autoUnlockScavenge);
            log('[scavenge] Auto desbloqueio ' + (CONFIG.autoUnlockScavenge ? 'ATIVADO' : 'DESATIVADO'), 'info');
            this._rerender();
        },

        showObsReport: function (report) {
            this.obsReport = report;
            this._rerender();
        },

        init: function () {
            if (this.el) this.el.remove();
            this.minimized = GM_getValue('tw_hud_min', false);
            var el = document.createElement('div');
            el.id = 'tw-bot-hud';
            el.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#121417;color:#ecf0f1;border-radius:10px;font-family:sans-serif;font-size:12px;z-index:99999;box-shadow:0 0 25px rgba(0,0,0,.9);border:1px solid #f39c12;min-width:290px;user-select:none;transition:all .3s;line-height:1.4;';
            el.innerHTML = this._html();
            document.body.appendChild(el);
            this.el = el;
            el.querySelector('#tw-hud-toggle').onclick = () => { this.minimized = !this.minimized; GM_setValue('tw_hud_min', this.minimized); this._rerender(); };
            el.querySelector('#tw-hud-obs-toggle').onclick = (e) => { e.stopPropagation(); this.toggleObsMode(); };
            this._bindButtons();
        },

        _html: function () {
            var obsBtnStyle = 'cursor:pointer;padding:2px 7px;border-radius:3px;font-size:10px;font-weight:bold;margin-right:6px;'
                + (this.obsMode
                    ? 'background:#c0392b;color:#fff;'
                    : 'background:#2c3e50;color:#7f8c8d;');
            var obsBtn = '<span id="tw-hud-obs-toggle" style="' + obsBtnStyle + '">' + (this.obsMode ? '👁 OBS' : '▶ LIVE') + '</span>';
            
            // Botão de toggle para desbloqueio de coletas
            var scavBtnStyle = 'cursor:pointer;padding:2px 7px;border-radius:3px;font-size:10px;font-weight:bold;margin-right:6px;'
                + (CONFIG.autoUnlockScavenge
                    ? 'background:#27ae60;color:#fff;'
                    : 'background:#2c3e50;color:#7f8c8d;');
            var scavBtn = '<span id="tw-hud-scav-toggle" style="' + scavBtnStyle + '" title="Auto Desbloquear Coletas">🔓 ' + (CONFIG.autoUnlockScavenge ? 'ON' : 'OFF') + '</span>';
            
            var hdr = '<div id="tw-hud-toggle" style="padding:10px;cursor:pointer;color:#f39c12;font-weight:bold;background:#1a1c20;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center;border-top-left-radius:10px;border-top-right-radius:10px;">'
                    + '<span>⚔️ Agente Gerencial TW</span>'
                    + '<div style="display:flex;align-items:center;">' + scavBtn + obsBtn + '<span>' + (this.minimized ? '[ + ]' : '[ — ]') + '</span></div>'
                    + '</div>';

            if (this.minimized) return hdr;

            var rows = '<div style="padding: 10px;">';

            // ── Bloco de Observação (quando modo ativo) ──
            if (this.obsMode) {
                var r = this.obsReport;
                rows += '<div style="background:#1a0505;padding:8px;border-radius:6px;margin-bottom:10px;border:1px solid #c0392b;">';
                rows += '<div style="font-size:11px;color:#e74c3c;font-weight:bold;margin-bottom:8px;">👁 MODO OBSERVAÇÃO — SEM EXECUÇÃO</div>';
                rows += this._buildDataRow('Fase:', this.info.fase, '#bdc3c7');
                rows += this._buildDataRow('Gargalo:', this.info.gargalo, '#e74c3c');
                rows += this._buildDataRow('Meta:', this.info.meta, '#3498db');
                if (r) {
                    rows += '<div style="margin-top:6px;padding-top:6px;border-top:1px dashed #333;"></div>';
                    rows += this._buildDataRow('Próxima ação:', (r.alvo || '—') + (r.nivel ? ' Nv.' + r.nivel : ''), '#2ecc71');
                    var confColor = r.confianca >= 80 ? '#2ecc71' : r.confianca >= 60 ? '#f39c12' : '#e74c3c';
                    rows += '<div style="background:#2c3e50;border-radius:3px;height:5px;margin:5px 0;overflow:hidden;">'
                         +  '<div style="background:' + confColor + ';height:100%;width:' + r.confianca + '%;"></div></div>';
                    rows += '<div style="text-align:right;font-size:10px;color:' + confColor + ';margin-bottom:4px;">Confiança: ' + r.confianca + '%</div>';
                    if (r.alternativa) rows += this._buildDataRow('Alternativa:', r.alternativa + (r.altNivel ? ' Nv.' + r.altNivel : ''), '#7f8c8d');
                    rows += '<div style="background:#202225;padding:5px;border-radius:4px;font-family:monospace;font-size:10px;color:#a29bfe;margin-top:4px;">💡 ' + (r.razao || this.info.motivo) + '</div>';
                } else {
                    rows += '<div style="color:#7f8c8d;font-size:10px;margin-top:4px;">Aguardando próximo ciclo de análise...</div>';
                }
                rows += '</div>';
            } else {
                // ── Bloco Gerencial normal ──
                rows += '<div style="background:#1a1c20; padding:8px; border-radius:6px; margin-bottom:10px; border:1px solid #333;">';
                rows += '<div style="font-size:11px; color:#f39c12; font-weight:bold; margin-bottom:6px;">📊 VISÃO ESTRATÉGICA</div>';
                rows += this._buildDataRow('Fase:', this.info.fase, '#bdc3c7');
                rows += this._buildDataRow('Gargalo:', this.info.gargalo, '#e74c3c');
                rows += '<div style="margin-top:6px; padding-top:6px; border-top:1px dashed #333;"></div>';
                rows += this._buildDataRow('Meta Atual:', this.info.meta, '#3498db');
                rows += this._buildDataRow('Alvo de Fila:', this.info.acao, '#2ecc71');
                var _learnSum = LearningEngine.getSummary(getCurrentVillageId());
                rows += '<div style="background:#202225; padding:5px; border-radius:4px; font-size:10px; color:#a29bfe; margin-top:6px;">'
                     + '🧠 <b>Aprendizado:</b> ' + _learnSum + '</div>';
                rows += '<div style="background:#202225; padding:6px; border-radius:5px; font-family:monospace; font-size:10.5px; color:#a29bfe; margin-top:8px;">'
                     + '💡 <b>Razão:</b> ' + this.info.motivo
                     + '</div></div>';
            }

            // ── Bloco Cluster (frota de aldeias) ──
            var _clusterVillages = VillageManager.villages || [];
            if (_clusterVillages.length > 1) {
                var _clusterRows = VillageCoordinator.getOverview(_clusterVillages);
                rows += '<div style="background:#1a1c20; padding:8px; border-radius:6px; margin-bottom:10px; border:1px solid #333;">';
                rows += '<div style="font-size:11px; color:#f39c12; font-weight:bold; margin-bottom:6px;">🌐 CLUSTER (' + _clusterVillages.length + ' aldeias)</div>';
                _clusterRows.forEach(function(v) {
                    var stagIcon  = v.stagnation === 'critical' ? ' ⚠️' : v.stagnation === 'warning' ? ' ℹ️' : '';
                    var nameStyle = 'color:' + (v.isCurrent ? '#f39c12' : '#bdc3c7') + '; font-size:10px;' + (v.isCurrent ? ' font-weight:bold;' : '');
                    var faseTag   = v.phase !== '?' ? ' [' + v.phase + ']' : '';
                    var filaTag   = ' fila:' + v.fila;
                    var ptsTag    = v.points ? ' ' + v.points + 'pts' : '';
                    rows += '<div style="display:flex; justify-content:space-between; align-items:center; padding:3px 4px; margin-bottom:2px; background:#202225; border-radius:3px;">';
                    rows += '<span style="' + nameStyle + '">' + v.icon + ' ' + (v.name.length > 12 ? v.name.slice(0, 12) + '…' : v.name) + stagIcon + '</span>';
                    rows += '<span style="color:#7f8c8d; font-size:9px;">' + v.profile.slice(0, 3).toUpperCase() + faseTag + filaTag + ptsTag + '</span>';
                    rows += '</div>';
                });
                rows += '</div>';
            }

            // ── Bloco Candidatos (scores ao vivo) ──
            if (this.candidates && this.candidates.length > 0) {
                var maxScore = this.candidates[0].score || 1;
                rows += '<div style="background:#1a1c20; padding:8px; border-radius:6px; margin-bottom:10px; border:1px solid #333;">';
                rows += '<div style="font-size:11px; color:#f39c12; font-weight:bold; margin-bottom:6px;">🏆 CANDIDATOS (score ao vivo)</div>';
                var pinned = this.pinnedBuilding;
                this.candidates.forEach(function(c, idx) {
                    var isWinner = idx === 0;
                    var isPinned = c.ed === pinned;
                    var pct      = Math.round((c.score / maxScore) * 100);
                    var barColor = isWinner ? '#f39c12' : '#2c3e50';
                    var multStr  = (c.learnedMult && Math.abs(c.learnedMult - 1) > 0.05)
                        ? '<span style="color:' + (c.learnedMult > 1 ? '#2ecc71' : '#e74c3c') + ';font-size:9px;"> ×' + c.learnedMult.toFixed(2) + '</span>'
                        : '';
                    var label    = c.ed.toUpperCase() + (c.constructionHours ? ' ' + c.constructionHours.toFixed(1) + 'h' : '');
                    var pinStyle = 'cursor:pointer; padding:1px 5px; border-radius:3px; font-size:9px; border:none; margin-left:2px; '
                        + (isPinned ? 'background:#e74c3c; color:#fff;' : 'background:#2c3e50; color:#bdc3c7;');
                    rows += '<div style="margin-bottom:5px;">';
                    rows += '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2px;">';
                    rows += '<span style="color:' + (isWinner ? '#f39c12' : '#bdc3c7') + '; font-size:10px; font-weight:' + (isWinner ? 'bold' : 'normal') + ';">'
                         + (isWinner ? '▶ ' : '  ') + label + multStr + '</span>';
                    rows += '<div style="display:flex; align-items:center; gap:3px;">';
                    rows += '<span style="color:#7f8c8d; font-size:9px;">' + Math.round(c.score) + '</span>';
                    rows += '<button class="tw-force-btn" data-building="' + c.ed + '" style="cursor:pointer; padding:1px 5px; border-radius:3px; font-size:9px; border:none; background:#27ae60; color:#fff;">⚡</button>';
                    rows += '<button class="tw-pin-btn" data-building="' + c.ed + '" style="' + pinStyle + '">' + (isPinned ? '📌' : '⊙') + '</button>';
                    rows += '</div></div>';
                    rows += '<div style="background:#2c3e50; border-radius:2px; height:3px; overflow:hidden;">'
                         +  '<div style="background:' + barColor + '; height:100%; width:' + pct + '%;"></div></div>';
                    rows += '</div>';
                });
                rows += '</div>';
            }

            // ── Bloco Objetivo da Aldeia ──
            var currentProfile = VillageMemory.get(getCurrentVillageId()).profile || 'balanced';
            var currentGoal    = this.GOAL_LABELS[currentProfile] || { icon: '⚖️', label: 'Auto' };
            rows += '<div style="background:#1a1c20; padding:8px; border-radius:6px; margin-bottom:10px; border:1px solid #333;">';
            rows += '<div style="font-size:11px; color:#f39c12; font-weight:bold; margin-bottom:6px;">🎯 OBJETIVO DA ALDEIA</div>';
            rows += '<div style="font-size:10px; color:#7f8c8d; margin-bottom:6px;">Ativo: <b style="color:#2ecc71;">' + currentGoal.icon + ' ' + currentGoal.label + '</b></div>';
            rows += '<div style="display:flex; flex-wrap:wrap; gap:4px;">';
            var self = this;
            Object.keys(this.GOAL_LABELS).forEach(function(profileKey) {
                var g = self.GOAL_LABELS[profileKey];
                var isActive = profileKey === currentProfile;
                var btnStyle = 'cursor:pointer; padding:3px 7px; border-radius:4px; font-size:10px; font-weight:bold; border:none; '
                    + (isActive
                        ? 'background:#f39c12; color:#121417;'
                        : 'background:#2c3e50; color:#bdc3c7;');
                rows += '<button class="tw-goal-btn" data-profile="' + profileKey + '" style="' + btnStyle + '">'
                     + g.icon + ' ' + g.label + '</button>';
            });
            rows += '</div></div>';

            // ── Bloco Operacional ──
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

        _bindButtons: function() {
            var self = this;
            if (!this.el) return;

            // Botões de objetivo (perfil)
            this.el.querySelectorAll('.tw-goal-btn').forEach(function(btn) {
                btn.onclick = function(e) {
                    e.stopPropagation();
                    var profile = btn.getAttribute('data-profile');
                    var vid = getCurrentVillageId();
                    if (vid && profile) {
                        VillageMemory.setProfile(vid, profile);
                        var g = self.GOAL_LABELS[profile] || { icon: '⚖️', label: profile };
                        log('[HUD] Objetivo alterado: ' + g.icon + ' ' + g.label, 'success');
                    }
                    self._rerender();
                };
            });

            // Botões de forçar build (one-shot)
            this.el.querySelectorAll('.tw-force-btn').forEach(function(btn) {
                btn.onclick = function(e) {
                    e.stopPropagation();
                    var building = btn.getAttribute('data-building');
                    if (building) self.setForced(building);
                    // Feedback visual rápido
                    btn.style.background = '#e67e22';
                    btn.textContent = '✓';
                    setTimeout(function() { if (self.el) self._rerender(); }, 1000);
                };
            });

            // Botões de pin (persistente)
            this.el.querySelectorAll('.tw-pin-btn').forEach(function(btn) {
                btn.onclick = function(e) {
                    e.stopPropagation();
                    var building = btn.getAttribute('data-building');
                    if (building) self.setPin(building);
                };
            });
        },

        _rerender: function () {
            if (this.el) this.el.innerHTML = this._html();
            this.el.querySelector('#tw-hud-toggle').onclick = () => { this.minimized = !this.minimized; GM_setValue('tw_hud_min', this.minimized); this._rerender(); };
            this.el.querySelector('#tw-hud-obs-toggle').onclick = (e) => { e.stopPropagation(); this.toggleObsMode(); };
            this.el.querySelector('#tw-hud-scav-toggle').onclick = (e) => { e.stopPropagation(); this.toggleScavengeUnlock(); };
            this._bindButtons();
        },

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

    // Scoring estratégico: perfil > fase > milestone > situação econômica
    // ctx: { profile, phase, milestoneId, taxaPop, riscoArmazem, recursosPercent }
    function scoreFlagStrategic(flag, ctx) {
        ctx = ctx || {};
        var profile = ctx.profile || 'balanced';
        var phase   = ctx.phase   || 'MID';

        // 1. Base: peso do perfil da aldeia
        var profileW = CATEGORY_PRIORITY_BY_PROFILE[profile] || CATEGORY_PRIORITY_BY_PROFILE.balanced;
        var score = profileW[flag.category] || 0;

        // 2. Modulação por fase (efeito secundário ±20%)
        var phaseW = CATEGORY_PRIORITY[phase] || CATEGORY_PRIORITY.MID;
        score = score * (0.80 + 0.20 * ((phaseW[flag.category] || 0) / 100));

        // 3. Bônus de nível (idêntico ao original)
        score += flag.level * 3;

        // 4. Alinhamento com milestone ativo
        var milId = ctx.milestoneId || '';
        if (milId) {
            if (/^(eco_base|eco_market|eco_scale|eco_advanced|hq_early|hq_mid|spd_eco_base|spd_hq5|spd_hq10|spd_1k)$/.test(milId)) {
                if (flag.category === 'resource')                                   score += 25;
            } else if (/^(mil_stable|mil_smith10|mil_barracks10|mil_full|hmr_iron8|hmr_barracks5|hmr_stable1|hmr_smith10|hmr_barracks10|hmr_full|ff_barracks10|ff_full_farm)$/.test(milId)) {
                if (flag.category === 'attack' || flag.category === 'recruitment') score += 30;
            } else if (/^(sup_wall10|sup_wall20|mil_wall)$/.test(milId)) {
                if (flag.category === 'defense')                                   score += 25;
            } else if (/^noble_prep$/.test(milId)) {
                if (flag.category === 'loot' || flag.category === 'resource')      score += 20;
            } else if (/^(unlock_statue|sup_church|sup_storage|spd_statue|spd_barracks)$/.test(milId)) {
                if (flag.category === 'population')                                score += 15;
            } else if (/^(ff_iron8|ff_barracks3|ff_wood8|ff_farm10)$/.test(milId)) {
                if (flag.category === 'loot')                                      score += 25;
            }
        }

        // 5. Situação econômica
        if (flag.category === 'resource') {
            if (ctx.riscoArmazem) score -= 30; // overflow: mais produção é desperdício
            var pct = ctx.recursosPercent || {};
            var avgFill = ((pct.wood || 0) + (pct.stone || 0) + (pct.iron || 0)) / 3;
            if (avgFill > 0.85) score -= 20;   // storage muito cheio
            if (avgFill < 0.25) score += 20;   // storage vazio — recurso urgente
        }
        if (flag.category === 'population') {
            var taxaPop = ctx.taxaPop || 0;
            if (taxaPop >= 0.92)      score += 40; // pop crítica: desbloquear slots urgente
            else if (taxaPop >= 0.82) score += 20;
        }

        return score;
    }

    // ============================================================
    // BACKGROUND: ASSIGN FLAG via AJAX Fantasma
    // 1. Baixa HTML de screen=flags → parseia candidatas por identidade (URL da imagem)
    // 2. Ordena por prioridade de fase, tenta cada uma sequencialmente
    // 3. O servidor diz quem voce possui: erro = pula para proxima, sucesso = para
    // ============================================================
    function bgAssignFlagGhost(villageId, phase, ctx) {
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

            // Ordena por score estratégico (perfil + milestone + situação) e limita tentativas
            var ph = phase || 'MID';
            var _ctx = ctx ? Object.assign({ phase: ph }, ctx) : { phase: ph };
            var sorted = candidates.slice()
                .sort(function (a, b) { return scoreFlagStrategic(b, _ctx) - scoreFlagStrategic(a, _ctx); })
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
            // Criar documento virtual para análise
            var doc = new DOMParser().parseFromString(html, 'text/html');

            // Verificar se estátua existe e tem nível >= 1
            var statueLevelEl = doc.querySelector('.statue_level_1, .statue_level_2, .statue-built, [data-statue-level]');
            var statueExists = statueLevelEl !== null;

            // Verificar indicadores de recrutamento disponíveis
            var canRecruit = html.indexOf('knight_recruit_launch') !== -1 ||
                            html.indexOf('recruit_knight') !== -1 ||
                            doc.querySelector('.knight_recruit_launch, #knight_recruit_btn') !== null;

            // Verificar se está recrutando atualmente
            var isRecruit = !canRecruit && (html.indexOf('knight_recruit_rush') !== -1 ||
                                            html.indexOf('knight_progress') !== -1 ||
                                            html.indexOf('knight_recruiting') !== -1);

            // Verificar se paladino já está presente (vivo na aldeia)
            var hasKnight = !canRecruit && !isRecruit && (
                html.indexOf('rename_knight')  !== -1 ||
                html.indexOf('knight_present') !== -1 ||
                html.indexOf('Verplaatsen')    !== -1 ||
                doc.querySelector('#rename_knight, .knight_present, #knight_info') !== null
            );

            // Se estátua existe mas paladino não está presente e não está recrutando,
            // pode estar morto/ausente (pode recrutar novamente)
            if (statueExists && !hasKnight && !isRecruit && !canRecruit) {
                // Verificar se há botão de reviver/recrutar
                var reviveBtn = doc.querySelector('.revive_knight, .resurrect_knight, [href*="revive"]');
                if (reviveBtn) {
                    canRecruit = true;
                    log('[knight] Paladino ausente/morto - pronto para reviver', 'info');
                }
            }

            var csrf = extractCsrf(html);
            return { canRecruit: canRecruit, isPresent: hasKnight, isRecruiting: isRecruit, csrf: csrf, statueExists: statueExists, htmlPura: html };
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
            var _csrfFallback = (typeof unsafeWindow !== 'undefined' && unsafeWindow.game_data)
                ? unsafeWindow.game_data.csrf
                : (typeof game_data !== 'undefined' && game_data ? game_data.csrf : '');
            var body = 'home=' + villageId + '&name=Paul&h=' + (state.csrf || _csrfFallback);

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
    // DESBLOQUEIO DE COLETAS (SCAVENGE)
    // ============================================================
    function bgUnlockScavenge(villageId, optionId) {
        log('[scavenge] Tentando desbloquear coleta (option_id=' + optionId + ')...', 'info');
        
        // Obter token CSRF
        var csrf = null;
        try {
            if (typeof unsafeWindow !== 'undefined' && unsafeWindow.game_data) {
                csrf = unsafeWindow.game_data.csrf;
            } else if (typeof game_data !== 'undefined' && game_data) {
                csrf = game_data.csrf;
            }
        } catch(e) {}
        
        if (!csrf) {
            log('[scavenge] Erro: CSRF não encontrado', 'error');
            return Promise.reject(new Error('CSRF não encontrado'));
        }
        
        var unlockUrl = window.location.origin + '/game.php?village=' + villageId + '&screen=scavenge_api&ajaxaction=start_unlock';
        var body = 'village_id=' + villageId + '&option_id=' + optionId + '&h=' + csrf;
        
        return twFetch(unlockUrl, 'POST', body).then(function (resp) {
            var json = {};
            try { json = JSON.parse(resp); } catch(e) {}
            
            if (json && json.error) {
                log('[scavenge] Erro ao desbloquear: ' + (json.error[0] || JSON.stringify(json.error)), 'error');
                return false;
            }
            log('[scavenge] Coleta desbloqueada com sucesso!', 'success');
            return true;
        }).catch(function (err) {
            log('[scavenge] Erro de rede: ' + err.message, 'error');
            return false;
        });
    }
    
    // Detecta se há coletas bloqueadas e retorna o option_id disponível
    function detectScavengeOptions(villageId) {
        return new Promise(function(resolve) {
            var scavengeUrl = window.location.origin + '/game.php?village=' + villageId + '&screen=scavenge_api';
            gmGet(scavengeUrl).then(function(html) {
                // Procura por botões de desbloqueio no HTML
                // Padrão: option_id nos botões do tipo "start_unlock"
                var patterns = [
                    /data-option-id=["'](\d+)["']/gi,
                    /option_id[\"']?\s*[:=]\s*[\"']?(\d+)/gi,
                    /name=["']option_id["']\s+value=["'](\d+)["']/gi
                ];
                
                for (var i = 0; i < patterns.length; i++) {
                    var matches = html.matchAll(patterns[i]);
                    for (var match of matches) {
                        var optId = parseInt(match[1]);
                        if (!isNaN(optId)) {
                            log('[scavenge] Opção de desbloqueio detectada: option_id=' + optId, 'info');
                            resolve({ available: true, optionId: optId });
                            return;
                        }
                    }
                }
                
                // Se não encontrou, verifica se já está desbloqueado
                if (html.indexOf('scavenge_active') > -1 || html.indexOf('coleta ativa') > -1) {
                    resolve({ available: false, reason: 'Já desbloqueado' });
                } else {
                    resolve({ available: false, reason: 'Nenhuma opção encontrada' });
                }
            }).catch(function(err) {
                log('[scavenge] Erro ao detectar opções: ' + err.message, 'error');
                resolve({ available: false, reason: 'Erro na detecção' });
            });
        });
    }
    
    // Função principal que verifica e desbloqueia automaticamente
    function checkAndUnlockScavenge(villageId) {
        if (!CONFIG.autoUnlockScavenge) {
            return Promise.resolve(false);
        }
        
        log('[scavenge] Verificando coletas bloqueadas...', 'info');
        return detectScavengeOptions(villageId).then(function(result) {
            if (result.available && result.optionId) {
                log('[scavenge] Coleta bloqueada detectada! Desbloqueando...', 'info');
                HUD.set('scavenge', 'running', 'Desbloqueando coleta...');
                return bgUnlockScavenge(villageId, result.optionId).then(function(success) {
                    if (success) {
                        HUD.set('scavenge', 'done', 'Desbloqueada!');
                    } else {
                        HUD.set('scavenge', 'error', 'Falha no desbloqueio');
                    }
                    return success;
                });
            } else {
                log('[scavenge] ' + (result.reason || 'Sem coletas para desbloquear'), 'info');
                HUD.set('scavenge', 'idle', result.reason || 'OK');
                return false;
            }
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
     * Prioriza leitura direta do HTML da página para precisão
     */
    function extractCosts(buildingId, mainDoc, fallbackCosts) {
        // 1. Linha canônica TW: #main_buildrow_{id}
        var row = mainDoc.querySelector('#main_buildrow_' + buildingId)
                || mainDoc.querySelector('tr[data-building="' + buildingId + '"]');

        if (row) {
            var tds = row.querySelectorAll('td');
            // TW layout: td[0]=nome td[1]=madeira td[2]=pedra td[3]=ferro td[4]=pop td[5]=tempo
            var parse = function(n) {
                var el = tds[n];
                if (!el) return 0;
                return parseInt((el.innerText || el.textContent || '').replace(/\./g, '').replace(/\D/g, '')) || 0;
            };
            var wood  = parse(1);
            var stone = parse(2);
            var iron  = parse(3);
            if (wood > 0 || stone > 0 || iron > 0) {
                return { wood: wood, stone: stone, iron: iron, fromDOM: true };
            }
        }

        // 2. Tooltip / elemento .costs
        var costEl = mainDoc.querySelector('#building_' + buildingId + ' .costs, .building-' + buildingId + ' .costs');
        if (costEl) {
            var text = costEl.textContent || costEl.innerText;
            var wood  = parseInt((text.match(/(\d[\d.]*)\s*(?:madeira|wood)/i)  || [])[1] || 0) || 0;
            var stone = parseInt((text.match(/(\d[\d.]*)\s*(?:pedra|stone)/i)   || [])[1] || 0) || 0;
            var iron  = parseInt((text.match(/(\d[\d.]*)\s*(?:ferro|iron)/i)    || [])[1] || 0) || 0;
            if (wood > 0 || stone > 0 || iron > 0) {
                return { wood: wood, stone: stone, iron: iron, fromDOM: true };
            }
        }

        // 3. Fallback: tabela estática TW_BUILDING_COSTS (sem fromDOM)
        if (fallbackCosts) {
            return { wood: fallbackCosts[0], stone: fallbackCosts[1], iron: fallbackCosts[2], time: fallbackCosts[3], fromDOM: false };
        }

        return null;
    }

    /**
     * Scraping automático de custos reais do mundo a partir do DOM de screen=main.
     * Chave de contexto: mundo + mercado + idioma. Revalida em 4 condições:
     * TTL 24h, mudança de contexto, confiança média < 40%, flag de revalidação forçada.
     * Overrides manuais (setCostOverride) nunca são sobrescritos.
     */
    function scrapeBuildingCostsFromDOM(mainDoc, villageLevels, worldId) {
        var ctxKey     = getCostContextKey(worldId);
        var SCRAPE_KEY = 'twbot_costs_scraped_' + ctxKey;
        var CONF_KEY   = 'twbot_cost_confidence_' + ctxKey;
        var DATA_KEY   = 'twbot_costs_data_' + ctxKey;
        var SCRAPE_TTL = 86400000; // 24 horas

        // Condição 1: contexto mudou (mundo, mercado ou idioma diferentes)
        var lastCtx    = GM_getValue('twbot_cost_context', '');
        var ctxChanged = lastCtx !== ctxKey;

        // Condição 2: confiança média abaixo do limiar (maioria dos custos veio de fallback estático)
        var conf = {};
        try { conf = JSON.parse(GM_getValue(CONF_KEY, null) || '{}'); } catch(e) {}
        var confKeys = Object.keys(conf);
        var avgConf  = confKeys.length > 0
            ? confKeys.reduce(function(s, k) { return s + (conf[k].score || 0); }, 0) / confKeys.length
            : 0;

        // Condição 3: flag de revalidação forçada (delta de custo detectado, mudança externa, etc.)
        var forceFlag = GM_getValue('twbot_force_rescrape', 0);

        var needsScrape = ctxChanged
            || forceFlag
            || (Date.now() - GM_getValue(SCRAPE_KEY, 0) >= SCRAPE_TTL)
            || (confKeys.length > 0 && avgConf < 40);

        if (!needsScrape) return;
        if (forceFlag) GM_setValue('twbot_force_rescrape', 0); // consumir flag

        var GROWTH_RES  = 1.5;
        var GROWTH_TIME = 1.1;
        var scraped = {};

        Object.keys(TW_BUILDING_COSTS).forEach(function(bId) {
            var currentLevel = parseInt(villageLevels[bId] || 0);
            if (currentLevel < 1) return;

            var row = mainDoc.querySelector(
                '#main_buildrow_' + bId + ', tr[data-building="' + bId + '"], tr#buildrow_' + bId
            );
            if (!row) return;

            var getCellNum = function(idx) {
                var cell = row.querySelector('td:nth-of-type(' + idx + ')');
                if (!cell) return 0;
                return parseInt((cell.textContent || '').trim().replace(/\./g, '').replace(/[^0-9]/g, '')) || 0;
            };

            var wood  = getCellNum(2);
            var stone = getCellNum(3);
            var iron  = getCellNum(4);
            if (wood <= 0 && stone <= 0 && iron <= 0) return;

            var timeSec = 0;
            for (var col = 5; col <= 7; col++) {
                var t = timeToSeconds(
                    ((row.querySelector('td:nth-of-type(' + col + ')') || {}).textContent || '').trim()
                );
                if (t > 0 && t < 86400) { timeSec = t; break; }
            }

            // Back-calcular custo base (nível 0→1) a partir do custo observado (nível L→L+1)
            var factor   = Math.pow(GROWTH_RES, currentLevel);
            var defaults = TW_BUILDING_COSTS[bId];
            var baseWood  = wood  > 0 ? Math.max(1, Math.round(wood  / factor)) : defaults[0];
            var baseStone = stone > 0 ? Math.max(1, Math.round(stone / factor)) : defaults[1];
            var baseIron  = iron  > 0 ? Math.max(0, Math.round(iron  / factor)) : defaults[2];
            var baseTime  = timeSec > 0 ? Math.max(10, Math.round(timeSec / Math.pow(GROWTH_TIME, currentLevel))) : defaults[3];

            var sane = function(calc, def) { if (def <= 0) return true; var r = calc / def; return r >= 0.1 && r <= 5.0; };
            if (!sane(baseWood, defaults[0]) || !sane(baseStone, defaults[1]) || !sane(baseIron, defaults[2])) {
                log('[costs-scraper] ' + bId + ': base fora do range, ignorado', 'debug');
                return;
            }

            scraped[bId] = [baseWood, baseStone, baseIron, baseTime];
            log('[costs-scraper] ' + bId + ' nv' + currentLevel + ': obs W=' + wood + '/S=' + stone + '/I=' + iron + '/T=' + timeSec + 's → base=[' + [baseWood, baseStone, baseIron, baseTime].join(',') + ']', 'debug');
        });

        var count = Object.keys(scraped).length;
        if (count === 0) {
            log('[costs-scraper] Nenhum custo extraído do DOM (estrutura não reconhecida)', 'warn');
            return;
        }

        // Mesclar com overrides manuais sem sobrescrever entradas manuais
        var stored = {};
        try {
            var raw = GM_getValue('twbot_costs_override', null);
            stored = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
        } catch(e) {}
        for (var b in scraped) {
            if (!stored[b]) {
                stored[b] = scraped[b];
                TW_BUILDING_COSTS[b] = scraped[b];
            }
        }

        // Atualizar confidence scores: cada hit do DOM aumenta confiança (+15, máx. 100)
        for (var bc in scraped) {
            if (!conf[bc]) conf[bc] = { score: 0, hits: 0, source: 'dom', ts: 0 };
            conf[bc].score  = Math.min(100, conf[bc].score + 15);
            conf[bc].hits++;
            conf[bc].source = 'dom';
            conf[bc].ts     = Date.now();
        }

        GM_setValue(DATA_KEY,  JSON.stringify(scraped));  // custos calibrados por contexto
        GM_setValue(CONF_KEY,  JSON.stringify(conf));      // confidence scores por edifício
        GM_setValue(SCRAPE_KEY, Date.now());
        GM_setValue('twbot_cost_context', ctxKey);        // registrar contexto atual
        log('[costs-scraper] ' + count + ' custos calibrados para contexto "' + ctxKey + '" | conf. média: ' + Math.round(avgConf) + '%', 'success');
    }

    /**
     * Verifica se há recursos suficientes AGORA para construir
     * Usa margem de tolerância de 15% para compensar erros de parsing do DOM
     */
    function hasEnoughResources(buildingId, state, costs) {
        if (!costs) {
            log('[recursos] Custos não disponíveis para ' + buildingId + ', assumindo disponível.', 'warning');
            return true;
        }

        // Usar recursos líquidos (descontando o que está comprometido na fila).
        // dispWood/dispStone/dispIron foram calculados em _collectVillageStateImpl.
        var rec = state.recursos || {};
        var availWood  = rec.dispWood  !== undefined ? rec.dispWood  : (rec.wood  || 0);
        var availStone = rec.dispStone !== undefined ? rec.dispStone : (rec.stone || 0);
        var availIron  = rec.dispIron  !== undefined ? rec.dispIron  : (rec.iron  || 0);

        // Tolerância de 5%: DOM ao vivo é preciso, mas pode haver lag de 1-2s
        var tol = 0.95;
        var enough = (availWood  >= (costs.wood  || 0) * tol) &&
                     (availStone >= (costs.stone || 0) * tol) &&
                     (availIron  >= (costs.iron  || 0) * tol);

        if (!enough) {
            log('[recursos] ' + buildingId + ': falta W=' +
                Math.max(0, (costs.wood||0) - availWood) +
                ' S=' + Math.max(0, (costs.stone||0) - availStone) +
                ' I=' + Math.max(0, (costs.iron||0) - availIron), 'info');
        }
        return enough;
    }

    /**
     * Verifica se o botão de upgrade está disponível e clicável
     */
    /**
     * Verifica se o botão de construção está disponível no DOM
     * Agora com detecção aprimorada de edifícios já construídos/em construção
     */
    // Verifica se um edifício pode ser construído agora com base no HTML do screen=main.
    // TW usa type=main para TODOS os edifícios — o ID vai no POST body (id=building).
    // Botões são JS-rendered: nunca há <a href> com ajaxaction no HTML bruto.
    // Portanto a detecção baseia-se na LINHA DA TABELA #main_buildrow_{id}.
    function isButtonAvailable(buildingId, mainDoc) {
        // --- 1. Linha canônica TW: #main_buildrow_{building} ---
        var buildRow = mainDoc.querySelector('#main_buildrow_' + buildingId);
        if (buildRow) {
            if (buildRow.style.display === 'none' || buildRow.classList.contains('hidden')) return false;
            var timerEl = buildRow.querySelector('.timer, .countdown, [id*="timer_"]');
            if (timerEl && timerEl.textContent.trim()) return false;
            var maxEl = buildRow.querySelector('.max-level, .level_max, .all, [data-max-level], .upgrade-button.all');
            if (maxEl) return false;
            return true;
        }

        // --- 2. Seletores alternativos: #main_buildlink_{building} ---
        var buildLink = mainDoc.querySelector(
            '#main_buildlink_' + buildingId + ':not(.inactive):not(.disabled),' +
            '#' + buildingId + '_buildlink:not(.inactive):not(.disabled),' +
            'a[id*="buildlink_' + buildingId + '"]:not(.disabled)'
        );
        if (buildLink && !buildLink.hasAttribute('disabled')) return true;

        // --- 3. Upgrade link com type=main (formato real do TW) ---
        var upgradeLinks = mainDoc.querySelectorAll('a[href*="ajaxaction=upgrade_building"]');
        if (upgradeLinks.length > 0) {
            for (var j = 0; j < upgradeLinks.length; j++) {
                var lnk = upgradeLinks[j];
                if (!lnk.classList.contains('disabled') && !lnk.hasAttribute('disabled')) return true;
            }
        }

        // --- 4. Estátua: estrutura própria ---
        if (buildingId === 'statue') {
            if (mainDoc.querySelector('.statue_level_1, .statue_level_2, .statue-built, [data-statue-level]')) return false;
            if (mainDoc.querySelector('.statue-slot-empty, .statue_empty, .empty_statue_slot')) return true;
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
            // Verificar se há indicador de "já em construção"
            if (json.already_queued || json.building_in_progress) {
                log('[verificação] ' + buildingId + ' já está em construção', 'info');
                return true; // Considera sucesso pois já está na fila
            }
        } catch (e) {
            // Fallback: buscar indicadores textuais de sucesso
            if (responseText.indexOf('success') !== -1 ||
                responseText.indexOf('order_id') !== -1 ||
                responseText.indexOf('queued') !== -1 ||
                responseText.indexOf('building_upgraded') !== -1) {
                return true;
            }
            // Verificar se não há erros evidentes
            if (responseText.indexOf('error') !== -1 ||
                responseText.indexOf('failed') !== -1 ||
                responseText.indexOf('not enough resources') !== -1) {
                log('[verificação] Erro detectado na resposta para ' + buildingId, 'error');
                return false;
            }
        }
        // Se chegou aqui sem indicação clara de erro, assume que pode ter funcionado
        // (alguns servidores retornam HTML parcial em vez de JSON)
        log('[verificação] Resposta ambígua para ' + buildingId + ', verificando conteúdo...', 'warning');
        return responseText.length > 50; // Se tem conteúdo razoável, assume sucesso
    }

    /**
     * Validação completa de build executável
     * Combina todas as verificações: pré-requisitos, recursos, botão, fila
     */
    function isBuildExecutable(buildingId, state, mainDoc) {
        // 1. Pré-requisitos básicos
        if (!state.podeSerConstruido[buildingId]) return false;

        // 2. Verificar se botão está disponível no DOM
        if (!isButtonAvailable(buildingId, mainDoc)) return false;

        // 3. Extrair custos (priorizar DOM, fallback tabela)
        var baseCosts = TW_BUILDING_COSTS[buildingId];
        var nivelAtual = parseInt(state.niveis[buildingId] || 0);
        var costs = extractCosts(buildingId, mainDoc, baseCosts);

        if (!costs) return false;

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
        var maxFila = (state.premium && state.premium.ativo) ? 5 : 2;
        if (state.filaBuilds >= maxFila) return false;

        return true;
    }

   function timeToSeconds(timeStr) {
        if (!timeStr) return 9999;
        var parts = timeStr.replace(/[^\d:]/g, '').split(':').map(Number);
        if (parts.length === 3) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
        if (parts.length === 2) return (parts[0] * 60) + parts[1];
        return 9999;
    }

    // ============================================================
    // LEITURA REAL DE RECURSOS — DOM AO VIVO (seletores confirmados pelo inspector)
    // Lê document (página ativa), não HTML fetchado — valores são real-time.
    // Produção vem do atributo data-title: "Argila - 433 por hora".
    // Hierarquia: DOM ao vivo > game_data > 0
    // ============================================================
    function readResourcesLive() {
        var r = {
            wood: 0, stone: 0, iron: 0, storageMax: 0,
            prod: { wood: 0, stone: 0, iron: 0 },
            pop:  { current: 0, max: 0 },
            ok: false
        };
        try {
            // Seletores confirmados: span#wood / span#stone / span#iron / span#storage
            var els = {
                wood:    document.querySelector('span#wood'),
                stone:   document.querySelector('span#stone'),
                iron:    document.querySelector('span#iron'),
                storage: document.querySelector('span#storage')
            };

            var toInt = function(el) {
                if (!el) return 0;
                return parseInt(el.textContent.trim().replace(/\./g, '').replace(/[^0-9]/g, '')) || 0;
            };

            r.wood       = toInt(els.wood);
            r.stone      = toInt(els.stone);
            r.iron       = toInt(els.iron);
            r.storageMax = toInt(els.storage);

            // Produção real por hora via data-title: "Madeira - 450 por hora"
            var parseProdTitle = function(el) {
                if (!el) return 0;
                var t = el.getAttribute('data-title') || '';
                var m = t.match(/[–\-]\s*([\d.]+)\s+por hora/i);
                return m ? parseInt(m[1].replace(/\./g, '')) || 0 : 0;
            };
            r.prod.wood  = parseProdTitle(els.wood);
            r.prod.stone = parseProdTitle(els.stone);
            r.prod.iron  = parseProdTitle(els.iron);

            // Farm / população: spans dedicados #pop_current_label e #pop_max_label (seletores confirmados)
            var popCurrentEl = document.querySelector('span#pop_current_label');
            var popMaxEl     = document.querySelector('span#pop_max_label');
            
            if (popCurrentEl && popMaxEl) {
                r.pop.current = parseInt(popCurrentEl.textContent.trim().replace(/[^0-9]/g, '')) || 0;
                r.pop.max     = parseInt(popMaxEl.textContent.trim().replace(/[^0-9]/g, '')) || 0;
            } else {
                // Fallback: tentar seletor antigo por data-title
                var farmEl = document.querySelector('[data-title="Fazenda"], [data-title="Farm"], [data-title="fazenda"]');
                if (farmEl) {
                    var fm = farmEl.textContent.trim().match(/(\d+)\s*\/\s*(\d+)/);
                    if (fm) { r.pop.current = parseInt(fm[1])||0; r.pop.max = parseInt(fm[2])||0; }
                }
            }

            r.ok = r.wood > 0 || r.stone > 0 || r.iron > 0;
            if (r.ok) {
                log('[recursos-live] W=' + r.wood + '/' + r.storageMax +
                    ' S=' + r.stone + ' I=' + r.iron +
                    ' | Prod W=' + r.prod.wood + ' S=' + r.prod.stone + ' I=' + r.prod.iron + '/h' +
                    ' | Pop=' + r.pop.current + '/' + r.pop.max, 'info');
            }
        } catch (e) {
            log('[recursos-live] Erro: ' + e.message, 'warning');
        }
        return r;
    }

    // ============================================================
    // CONSUMO FUTURO DA FILA DE CONSTRUÇÃO
    // Calcula total de recursos comprometidos em obras já enfileiradas.
    // Usado para saber se nova obra vai causar déficit de recurso.
    // ============================================================
    function estimateBuildQueueConsumption(mainDoc, niveis) {
        var total = { wood: 0, stone: 0, iron: 0, items: 0 };
        if (!mainDoc) return total;
        try {
            var rows = mainDoc.querySelectorAll(
                '#build_queue tr[id^="order_"], .buildqueue_container tr[id^="order_"], tr[id^="order_"]'
            );
            rows.forEach(function(row) {
                // Método A: células com classe de recurso explícita
                var costW = row.querySelector('.cost_wood, .wood_cost, td.wood');
                var costS = row.querySelector('.cost_stone, .stone_cost, td.stone');
                var costI = row.querySelector('.cost_iron, .iron_cost, td.iron');
                if (costW || costS || costI) {
                    var n = function(el) { return el ? (parseInt(el.textContent.replace(/[^0-9]/g, '')) || 0) : 0; };
                    total.wood  += n(costW);
                    total.stone += n(costS);
                    total.iron  += n(costI);
                    total.items++;
                    return;
                }
                // Método B: extrair building do link e calcular via TW_BUILDING_COSTS
                var link = row.querySelector('a[href*="building="], a[href*="type="]');
                var bName = null;
                if (link) {
                    var mB = (link.getAttribute('href') || '').match(/(?:building|type)=([a-z_]+)/);
                    if (mB) bName = mB[1];
                }
                if (!bName) {
                    // Método C: data-building ou data-type no próprio row
                    bName = row.getAttribute('data-building') || row.getAttribute('data-type');
                }
                if (bName && TW_BUILDING_COSTS[bName]) {
                    var lvl = parseInt((niveis && niveis[bName]) || 0);
                    var c   = TW_BUILDING_COSTS[bName];
                    total.wood  += Math.floor(c[0] * Math.pow(1.5, lvl));
                    total.stone += Math.floor(c[1] * Math.pow(1.5, lvl));
                    total.iron  += Math.floor(c[2] * Math.pow(1.5, lvl));
                    total.items++;
                }
            });
            if (total.items > 0) {
                log('[fila] Consumo comprometido: W=' + total.wood + ' S=' + total.stone + ' I=' + total.iron + ' (' + total.items + ' obras)', 'info');
            }
        } catch (e) {
            log('[fila] Erro ao calcular consumo: ' + e.message, 'warning');
        }
        return total;
    }

    function collectVillageState(villageId) {
        // Garante que erros síncronos (ex.: game_data nulo) rejeitem a Promise
        // em vez de lançar antes do encadeamento .then/.catch do chamador
        try {
            return _collectVillageStateImpl(villageId);
        } catch (e) {
            log('[collectVillageState] Erro síncrono: ' + e.message, 'error');
            return Promise.reject(e);
        }
    }

    function _collectVillageStateImpl(villageId) {
        var origin = window.location.origin;
        var safeStr = function (p) { return p.catch(function() { return ''; }); };
        var statueEnabled = false;
        try {
            statueEnabled = typeof game_data !== 'undefined'
                && game_data !== null
                && game_data.village != null
                && game_data.village.buildings != null
                && game_data.village.buildings.statue !== undefined;
        } catch (e) { statueEnabled = false; }

        // Limpar cache expirado antes de coletar novo estado
        RequestCache.cleanup();

        // Buscar dados adicionais para previsão de overflow (loot e rewards)
        // Nota: Em versão futura, buscar screen=overview_v para ataques em andamento
        // e screen=place para quests/tasks ativas

        // Quest popup: busca no máximo uma vez a cada 5 minutos por aldeia
        var QUEST_TTL  = 300000;
        var questTsKey = 'twbot_quest_ts_' + villageId;
        var lastQuestTs = GM_getValue(questTsKey, 0);
        var sinceLast = Date.now() - lastQuestTs;

        // Força refresh se: (1) nunca buscou, (2) TTL expirou, ou (3) último resultado foi vazio
        var cachedQuest = GM_getValue('twbot_quest_html_' + villageId, '');
        var forceRefresh = !cachedQuest || sinceLast > QUEST_TTL;

        if (forceRefresh) {
            GM_setValue(questTsKey, Date.now());
        }

        var questUrl = origin + '/game.php?village=' + villageId + '&screen=new_quests&ajax=quest_popup&tab=main-tab&quest=0';

        // Usar cache para reduzir requisições redundantes
        return Promise.all([
            safeStr(gmGet(origin + '/game.php?village=' + villageId + '&screen=flags', true)),
            safeStr(gmGet(origin + '/game.php?village=' + villageId + '&screen=main', true)),
            statueEnabled ? getKnightState(villageId) : Promise.resolve({ canRecruit: false, isPresent: false, isRecruiting: false, statueExists: false }),
            forceRefresh
                ? safeStr(twFetch(questUrl, 'GET', null, false).then(function(responseText) {
                      // O servidor TW retorna JSON: {response:{dialog:"<html>..."}}
                      // gmGet usava GM_xmlhttpRequest que não enviava cookies de sessão → recebia redirect
                      // twFetch usa window.fetch com credentials:'include' → recebe o JSON correto
                      var dialogHtml = '';
                      try {
                          var parsed = JSON.parse(responseText);
                          if (parsed.response && parsed.response.dialog) {
                              dialogHtml = parsed.response.dialog;
                          } else if (parsed.redirect) {
                              log('[collectVillageState] Quest: servidor retornou redirect inesperado: ' + parsed.redirect, 'warning');
                          }
                      } catch (e) {
                          // Não é JSON — trata como HTML direto (fallback)
                          dialogHtml = responseText || '';
                      }
                      GM_setValue('twbot_quest_html_' + villageId, dialogHtml);
                      log('[collectVillageState] Quest HTML: ' + (dialogHtml ? dialogHtml.slice(0, 200).replace(/\s+/g, ' ') : '(vazio)'), dialogHtml ? 'info' : 'warning');
                      return dialogHtml;
                  }))
                : Promise.resolve(cachedQuest)
        ]).then(function (results) {
            var flagsHtml = results[0], mainHtml = results[1], statueInfo = results[2], questHtml = results[3] || '';
            var mainDoc = new DOMParser().parseFromString(mainHtml, 'text/html');
            var rawData = typeof game_data !== 'undefined' ? game_data : {};

            // --- DETECÇÃO DE RUSH (Obras e Paladino) ---
            var rushCandidates = [];
            var buildQueueRows = mainDoc.querySelectorAll('#build_queue tr[id^="order_"], #build_queue tr, .buildqueue_container tr, tr[id^="order_"]');

            buildQueueRows.forEach((row, index) => {
                var timerEl = row.querySelector('.timer, .time_remaining, span[style*="color"]');
                if (!timerEl) return;
                var secondsLeft = timeToSeconds(timerEl.textContent.trim());
                if (secondsLeft > 0 && secondsLeft < (CONFIG.freeRushMinutes * 60 + 120)) {
                    var orderId = row.id.replace('order_', '');
                    var idLink  = row.querySelector('a[href*="id="')?.getAttribute('href') || '';
                    var m = idLink.match(/id=(\d+)/);
                    if (m && m[1]) {
                        rushCandidates.push(m[1]);
                        log('[rush] RUSH elegível: obra ID=' + m[1] + ' (' + secondsLeft + 's restantes)', 'success');
                    } else if (orderId && !isNaN(orderId)) {
                        rushCandidates.push(orderId);
                        log('[rush] RUSH elegível: obra ID=' + orderId + ' (' + secondsLeft + 's restantes)', 'success');
                    }
                }
            });

            var knightRushId = null;
            if (statueInfo.isRecruiting) {
                var mK = (statueInfo.htmlPura || '').match(/knight=(\d+)/) || (statueInfo.htmlPura || '').match(/data-knight=["'](\d+)/);
                if (mK) { knightRushId = mK[1]; log('[rush] Paladino elegível para rush ID=' + knightRushId, 'success'); }
            }

            // Estimar loot esperado baseado em recursos disponíveis para saque (simplificado)
            // Em versão completa, buscar attacks em andamento via overview_v
            var lootEstimadoSimples = (rawData.village.wood_float + rawData.village.stone_float + rawData.village.iron_float) * 0.1; // 10% dos recursos como estimativa de loot incoming

            // ── LEITURA REAL DE RECURSOS (ao vivo + game_data como fallback) ──────────
            // 1. DOM ao vivo (span#wood/stone/iron/storage, data-title produção, farm)
            var live = readResourcesLive();

            // 2. game_data como fallback — valores em recursos/segundo, convertidos para /h
            var gdWood  = parseFloat((rawData.village || {}).wood_float  || (rawData.village || {}).wood  || 0) || 0;
            var gdStone = parseFloat((rawData.village || {}).stone_float || (rawData.village || {}).stone || 0) || 0;
            var gdIron  = parseFloat((rawData.village || {}).iron_float  || (rawData.village || {}).iron  || 0) || 0;
            var gdStorage = parseInt((rawData.village || {}).storage_max || 0) || 0;
            var gdProdW = (parseFloat((rawData.village || {}).wood_prod)  || 0) * 3600;
            var gdProdS = (parseFloat((rawData.village || {}).stone_prod) || 0) * 3600;
            var gdProdI = (parseFloat((rawData.village || {}).iron_prod)  || 0) * 3600;
            var gdPop    = parseInt((rawData.village || {}).pop     || 0) || 0;
            var gdPopMax = parseInt((rawData.village || {}).pop_max || 0) || 0;

            // 3. Hierarquia: DOM ao vivo > game_data > 0
            var finalWood    = live.wood    > 0 ? live.wood    : gdWood;
            var finalStone   = live.stone   > 0 ? live.stone   : gdStone;
            var finalIron    = live.iron    > 0 ? live.iron    : gdIron;
            var finalStorage = live.storageMax > 0 ? live.storageMax : gdStorage;
            var finalProdW   = live.prod.wood  > 0 ? live.prod.wood  : gdProdW;
            var finalProdS   = live.prod.stone > 0 ? live.prod.stone : gdProdS;
            var finalProdI   = live.prod.iron  > 0 ? live.prod.iron  : gdProdI;
            var finalPop     = live.pop.current > 0 ? live.pop.current : gdPop;
            var finalPopMax  = live.pop.max     > 0 ? live.pop.max     : gdPopMax;

            // ── CONSUMO FUTURO DA FILA ──────────────────────────────────────────────
            var queueCost = estimateBuildQueueConsumption(mainDoc, (rawData.village || {}).buildings);

            // ── CALIBRAÇÃO DE CUSTOS REAIS DO MUNDO (uma vez/24h) ──────────────────
            try {
                var _worldId = (rawData.world) || window.location.hostname.replace(/[^a-z0-9]/gi, '_');
                scrapeBuildingCostsFromDOM(mainDoc, (rawData.village || {}).buildings || {}, _worldId);
            } catch(e) {
                log('[costs-scraper] Erro: ' + e.message, 'warning');
            }

            var state = {
                villageId: villageId,
                csrf: rawData.csrf || extractCsrf(mainHtml),
                statueEnabled: statueEnabled,
                recursos: {
                    wood:  finalWood,
                    stone: finalStone,
                    iron:  finalIron,
                    max:   finalStorage,
                    // Recursos disponíveis líquidos = atual - comprometido na fila
                    dispWood:  Math.max(0, finalWood  - queueCost.wood),
                    dispStone: Math.max(0, finalStone - queueCost.stone),
                    dispIron:  Math.max(0, finalIron  - queueCost.iron)
                },
                producao: {
                    wood:  finalProdW,
                    stone: finalProdS,
                    iron:  finalProdI
                },
                populacao: { current: finalPop, max: finalPopMax },
                buildQueueCost: queueCost,   // consumo comprometido na fila
                niveis: (rawData.village || {}).buildings,
                filaBuilds: mainDoc.querySelectorAll('.lit-item, #build_queue tr .timer').length,
                rushIds: rushCandidates,
                knightRushId: knightRushId,
                premium: { ativo: !!(rawData.features?.Premium?.active) },
                phase: getGamePhase(parseInt((rawData.village || {}).points || 0)),
                flags: parseFlagsFromHtml(flagsHtml),
                flagAssigned: isFlagAssignedInHtml(flagsHtml),
                knight: statueInfo,
                podeSerConstruido: {},
                lootEsperado: lootEstimadoSimples,
                rewardsEsperados: 0,
                questRewards: parseQuestRewards(questHtml),
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
    // ============================================================
    // ROI DE CONSTRUÇÃO — benefício real por hora de obra
    // Fórmula base: roi = beneficio_real_por_hora / tempo_construcao_em_horas
    // Inclui redução do HQ no tempo real. Cada tipo de edifício tem função própria.
    // ============================================================
    function calcBuildROI(ed, nivelAtual, state, tempoAteGargalo, recursosPercent) {
        var nivelHQ = parseInt(state.niveis['main'] || 0);
        var hqBonus = HQ_PRODUCTIVITY_BONUS[nivelHQ] || 0;

        // Tempo real de construção em horas, com redução do HQ (min 3s p/ evitar /0)
        var custoEd    = TW_BUILDING_COSTS[ed] || [100, 100, 100, 60];
        var tempoBaseS = custoEd[3] || 60;
        var tempoNivelS   = Math.floor(tempoBaseS * Math.pow(1.1, nivelAtual));
        var tempoComHQS   = tempoNivelS / (1 + hqBonus);
        var tempoHoras    = Math.max(0.001, tempoComHQS / 3600);

        var prodW = state.producao.wood  || 0;
        var prodS = state.producao.stone || 0;
        var prodI = state.producao.iron  || 0;
        var prodTotal = Math.max(1, prodW + prodS + prodI);

        var beneficio = 0;
        var label     = 'genérico';

        if (ed === 'wood' || ed === 'stone' || ed === 'iron') {
            // δ produção = prod_atual × 16,3% (taxa de crescimento TW por nível)
            var prodAtual = state.producao[ed] || 30;
            beneficio = prodAtual * 0.163;
            label = '+' + Math.round(beneficio) + ' ' + ed + '/h';

        } else if (ed === 'farm') {
            // δ pop × (prodTotal / popMax) — cada pop extra vale prod/pop por hora
            var popMax    = Math.max(1, state.populacao.max || 240);
            var deltaPopCap = popMax * 0.172; // ~17,2% crescimento/nível TW
            beneficio = prodTotal * (deltaPopCap / popMax); // = prodTotal * 0.172
            label = '+' + Math.round(deltaPopCap) + ' pop ≈ +' + Math.round(beneficio) + '/h';

        } else if (ed === 'storage') {
            // Evita overflow: benefício proporcional ao risco de perda real
            var tGarg = (tempoAteGargalo > 0 && tempoAteGargalo < 900) ? tempoAteGargalo : 900;
            var fatorOverflow = Math.min(3.0, 2.0 / tGarg); // alto risco → alto fator
            // Capacidade adicional ≈ 30% por nível; benefício = prod_em_risco × fator
            var capAtual = Math.max(1, state.recursos.max || 1000);
            beneficio = (prodTotal / 3) * fatorOverflow * 0.30;
            label = '+cap | overflow_risco=' + (tGarg < 900 ? tGarg.toFixed(1) + 'h' : 'baixo');

        } else if (ed === 'main') {
            // Reduz tempo de TODAS as futuras obras
            var bonusAtual = HQ_PRODUCTIVITY_BONUS[nivelAtual]     || 0;
            var bonusProx  = HQ_PRODUCTIVITY_BONUS[nivelAtual + 1] || bonusAtual;
            var deltaBonus = bonusProx - bonusAtual; // ex: 0.04 = 4% mais rápido
            var obrasEstimadas = Math.max(5, 25 - nivelAtual);
            var tempoPorObra   = 600; // s — proxy conservador (10 min/obra média)
            var tempoEconomizado = obrasEstimadas * tempoPorObra * deltaBonus;
            // Valor economizado = prodTotal × horas salvas
            beneficio = prodTotal * (tempoEconomizado / 3600);
            label = '+' + (deltaBonus * 100).toFixed(1) + '% vel | ' + Math.round(tempoEconomizado / 60) + 'min econ.';

        } else if (ed === 'barracks') {
            // Recrutamento de infantaria — escala com nível
            beneficio = prodTotal * 0.15 * (1 + nivelAtual * 0.05) * 0.10;
            label = '+inf recrutamento';

        } else if (ed === 'stable') {
            // Cavalaria leve — alto valor ofensivo por custo
            beneficio = prodTotal * 0.22 * (1 + nivelAtual * 0.04) * 0.12;
            label = '+cavalaria';

        } else if (ed === 'smith') {
            // Pesquisas militares — impacto indireto mas real
            beneficio = prodTotal * 0.18 * (1 + nivelAtual * 0.03) * 0.08;
            label = '+pesquisa';

        } else if (ed === 'wall') {
            // Defesa passiva: +13% ataque exigido por nível
            var fatorDef = Math.min(1.5, 0.13 * nivelAtual);
            beneficio = prodTotal * fatorDef * 0.05;
            label = '+def ' + Math.round(fatorDef * 100) + '%';

        } else if (ed === 'market') {
            // Eficiência de troca de recursos
            beneficio = prodTotal * Math.min(1.0, 0.10 * (nivelAtual + 1)) * 0.12;
            label = '+comércio';

        } else {
            var pesoFb = (STRATEGIC_WEIGHT[state.phase] || {})[ed] || 0.5;
            beneficio = prodTotal * pesoFb * 0.03;
            label = '+util(' + ed + ')';
        }

        var roi = Math.max(0.001, beneficio / tempoHoras);
        // Amplifica ROI com o aprendizado histórico deste tipo de edifício
        var learnedMult = LearningEngine.getMult(state.villageId, ed);
        var roiLearned  = roi * learnedMult;
        return {
            benefitPerHour:    Math.max(0, beneficio),
            constructionHours: tempoHoras,
            constructionSecs:  tempoComHQS,
            roi:               roiLearned,
            roiRaw:            roi,
            learnedMult:       learnedMult,
            label:             label + (learnedMult !== 1.0 ? ' ×' + learnedMult.toFixed(2) : '')
        };
    }

    // ============================================================
    // LEARNING ENGINE — aprendizado de eficiência por tipo de edifício
    // Compara ROI previsto vs. variação real de produção 30 min após build.
    // Atualiza um multiplicador EMA por building → ajusta decisões futuras.
    // ============================================================
    var LearningEngine = {
        KEY:   'twbot_learn_',
        ALPHA: 0.20,  // 20% peso para novo dado (EMA)

        _load: function(vid) {
            try {
                var raw = GM_getValue(this.KEY + vid, null);
                return raw ? JSON.parse(raw) : { mult: {}, pending: [] };
            } catch(e) { return { mult: {}, pending: [] }; }
        },

        _save: function(vid, d) {
            if (d.pending && d.pending.length > 30) d.pending = d.pending.slice(-30);
            GM_setValue(this.KEY + vid, JSON.stringify(d));
        },

        // Registra um build concluído para observação futura (chamado após build_general sucesso)
        recordBuild: function(vid, building, level, roiExpected, currentProdTotal) {
            if (!vid || !building) return;
            var d = this._load(vid);
            d.pending.push({
                b: building, lv: level,
                roi: roiExpected || 0.001,
                prod0: currentProdTotal || 0,
                ts: Date.now()
            });
            this._save(vid, d);
            log('[learn] Monitorando build: ' + building + ' Nv.' + level + ' (prod base=' + currentProdTotal + ')', 'info');
        },

        // Processado a cada ciclo — finaliza observações com mais de 30 minutos
        tick: function(vid, currentProdTotal) {
            if (!vid) return;
            var d = this._load(vid);
            var now = Date.now();
            var remaining = [];

            d.pending.forEach(function(p) {
                if (now - p.ts < 1800000) { remaining.push(p); return; } // aguarda 30 min

                var elapsedH = (now - p.ts) / 3600000;
                var actualDelta = currentProdTotal - p.prod0;
                var expectedDelta = p.roi * elapsedH;

                if (expectedDelta > 0.5 && elapsedH < 6) { // dado válido
                    var ratio = Math.max(0.1, Math.min(8, actualDelta / expectedDelta));
                    var old   = d.mult[p.b] || 1.0;
                    d.mult[p.b] = old * (1 - LearningEngine.ALPHA) + ratio * LearningEngine.ALPHA;
                    d.mult[p.b] = Math.max(0.3, Math.min(3.0, d.mult[p.b]));
                    var tag = d.mult[p.b] > 1.15 ? '✅ acima do esperado'
                            : d.mult[p.b] < 0.85 ? '⚠️ abaixo do esperado' : '✓ esperado';
                    log('[learn] ' + p.b + ' Nv.' + p.lv + ': real/previsto=' + ratio.toFixed(2)
                        + ' → mult=' + d.mult[p.b].toFixed(2) + ' ' + tag, 'info');
                }
            });

            d.pending = remaining;
            this._save(vid, d);
        },

        // Retorna multiplicador aprendido para um edifício (1.0 = sem histórico)
        getMult: function(vid, building) {
            if (!vid || !building) return 1.0;
            try { return this._load(vid).mult[building] || 1.0; } catch(e) { return 1.0; }
        },

        // Resumo legível para o HUD
        getSummary: function(vid) {
            try {
                var mults = this._load(vid).mult || {};
                var keys  = Object.keys(mults);
                if (!keys.length) return 'Coletando dados...';
                var sorted = keys.slice().sort(function(a, b) { return mults[b] - mults[a]; });
                var top = sorted.filter(function(k) { return mults[k] >= 1.15; }).slice(0, 2);
                var bot = sorted.filter(function(k) { return mults[k] <= 0.85; }).slice(0, 2);
                var parts = [];
                if (top.length) parts.push('✅ ' + top.join(', '));
                if (bot.length) parts.push('⚠️ ' + bot.join(', '));
                return parts.length ? parts.join(' | ') : '✓ dentro do esperado';
            } catch(e) { return '—'; }
        },

        reset: function(vid) {
            GM_deleteValue(this.KEY + vid);
            log('[learn] Dados de aprendizado resetados para aldeia ' + vid, 'info');
        }
    };

    // ============================================================
    // INSPETOR DE BOT - DETECÇÃO DE GARGALO IMINENTE
    // Calcula quando o armazém vai encher e compara com o próximo ciclo do bot.
    // Se HorasParaEncher < TempoProximoCiclo, o bot DEVE interromper a fila normal
    // e subir Armazém ou a Mina específica que está causando o gargalo.
    // Retorna: { riscoOverflow: bool, horasParaEncher: number, recursoGargalo: string, deveInterromper: bool }
    // ============================================================

    // ============================================================
    // INSPETOR DE FILA DE TREINAMENTO - GARFO DE POPULAÇÃO
    // Lê a fila de recrutamento do Quartel e Estábulo para calcular
    // População Futura = População Atual + Tropas na Fila
    // Se População Futura >= Limite da Fazenda, Farm é prioridade ZERO
    // Seletores usados: #trainqueue_wrap_barracks, #trainqueue_wrap_stable, tr[id^="trainorder_"]
    // ============================================================
    function getTrainingQueueInfo(mainDoc) {
        var queueInfo = {
            barracks: { count: 0, population: 0, units: [] },
            stable:   { count: 0, population: 0, units: [] },
            totalPopulation: 0
        };

        if (!mainDoc) return queueInfo;

        try {
            // Custo de população por tipo de unidade (padrão TW)
            var UNIT_POP_COST = {
                'spear': 1, 'sword': 1, 'axe': 1, 'archer': 1,
                'light': 3, 'marcher': 3, 'heavy': 5, 'ram': 4, 'catapult': 6,
                'snob': 10, 'knight': 1, 'spy': 1
            };

            // Varre fila do quartel: #trainqueue_wrap_barracks ou #trainqueue_barracks
            var barracksRows = mainDoc.querySelectorAll('#trainqueue_wrap_barracks tr[id^="trainorder_"], #trainqueue_barracks tr[id^="trainorder_"]');
            barracksRows.forEach(function(row) {
                var unitLink = row.querySelector('a[href*="unit="]');
                if (unitLink) {
                    var href = unitLink.getAttribute('href') || '';
                    var match = href.match(/unit=([a-z_]+)/);
                    var unitType = match ? match[1] : 'unknown';
                    
                    // Extrair quantidade da célula de texto (seletor fornecido: td:nth-of-type(1))
                    var textCell = row.querySelector('td:nth-of-type(1)');
                    var qtyMatch = textCell ? textCell.textContent.trim().match(/(\d+)/) : null;
                    var qty = qtyMatch ? parseInt(qtyMatch[1]) : 1;

                    var popCost = UNIT_POP_COST[unitType] || 1;
                    queueInfo.barracks.count += qty;
                    queueInfo.barracks.population += qty * popCost;
                    queueInfo.barracks.units.push({ type: unitType, qty: qty, pop: popCost });
                }
            });

            // Varre fila do estábulo: #trainqueue_wrap_stable ou #trainqueue_stable
            var stableRows = mainDoc.querySelectorAll('#trainqueue_wrap_stable tr[id^="trainorder_"], #trainqueue_stable tr[id^="trainorder_"]');
            stableRows.forEach(function(row) {
                var unitLink = row.querySelector('a[href*="unit="]');
                if (unitLink) {
                    var href = unitLink.getAttribute('href') || '';
                    var match = href.match(/unit=([a-z_]+)/);
                    var unitType = match ? match[1] : 'unknown';
                    
                    var textCell = row.querySelector('td:nth-of-type(1)');
                    var qtyMatch = textCell ? textCell.textContent.trim().match(/(\d+)/) : null;
                    var qty = qtyMatch ? parseInt(qtyMatch[1]) : 1;

                    var popCost = UNIT_POP_COST[unitType] || 1;
                    queueInfo.stable.count += qty;
                    queueInfo.stable.population += qty * popCost;
                    queueInfo.stable.units.push({ type: unitType, qty: qty, pop: popCost });
                }
            });

            queueInfo.totalPopulation = queueInfo.barracks.population + queueInfo.stable.population;

            if (queueInfo.totalPopulation > 0) {
                log('[fila-tropas] Quartel: ' + queueInfo.barracks.count + ' unidades (' + 
                    queueInfo.barracks.population + ' pop) | Estábulo: ' + queueInfo.stable.count + 
                    ' unidades (' + queueInfo.stable.population + ' pop) | Total: ' + 
                    queueInfo.totalPopulation + ' pop comprometida', 'info');
            }
        } catch (e) {
            log('[fila-tropas] Erro: ' + e.message, 'warning');
        }

        return queueInfo;
    }

    // ============================================================
    // INSPETOR DE POPULAÇÃO - GARFO DE FARM
    // Calcula: População Livre = Capacidade - População Atual
    // População Futura = População Atual + Tropas na Fila
    // Se População Futura >= Limite, Farm é prioridade ZERO (Idle Militar = Morte)
    // ============================================================
    function inspetorDePopulacao(state, queueInfo) {
        var resultado = {
            populacaoLivre: 0,
            populacaoComprometida: 0,
            populacaoFutura: 0,
            limiteFarm: 0,
            deficit: 0,
            devePriorizarFarm: false,
            nivelAlerta: 'normal',
            margemSegura: 0
        };

        try {
            resultado.limiteFarm = state.populacao.max || 1;
            resultado.populacaoComprometida = queueInfo.totalPopulation || 0;
            resultado.populacaoLivre = (state.populacao.max || 0) - (state.populacao.current || 0);
            resultado.populacaoFutura = (state.populacao.current || 0) + resultado.populacaoComprometida;

            // Calcular déficit: se população futura > limite, temos problema
            resultado.deficit = resultado.populacaoFutura - resultado.limiteFarm;
            resultado.margemSegura = resultado.limiteFarm - resultado.populacaoFutura;

            // Níveis de alerta baseados na taxa de ocupação futura
            var taxaOcupacaoFutura = (resultado.populacaoFutura / resultado.limiteFarm) * 100;

            if (resultado.deficit > 0 || taxaOcupacaoFutura >= 98) {
                resultado.nivelAlerta = 'emergencia';
                resultado.devePriorizarFarm = true;
                log('[Inspetor de População] 🚨 EMERGÊNCIA: Farm saturado! Déficit de ' + 
                    resultado.deficit + ' pop | Ocupação futura: ' + taxaOcupacaoFutura.toFixed(1) + '%', 'error');
            } else if (taxaOcupacaoFutura >= 95) {
                resultado.nivelAlerta = 'prioridade_alta';
                resultado.devePriorizarFarm = true;
                log('[Inspetor de População] ⚠️ PRIORIDADE ALTA: Farm quase cheio (' + 
                    taxaOcupacaoFutura.toFixed(1) + '%) | Margem: ' + resultado.margemSegura + ' pop', 'warning');
            } else if (taxaOcupacaoFutura >= 90) {
                resultado.nivelAlerta = 'preparacao';
                resultado.devePrioritarFarm = false;
                log('[Inspetor de População] 📋 PREPARAÇÃO: Farm em ' + 
                    taxaOcupacaoFutura.toFixed(1) + '% | Margem: ' + resultado.margemSegura + ' pop', 'info');
            } else if (taxaOcupacaoFutura >= 80) {
                resultado.nivelAlerta = 'observacao';
                resultado.devePrioritarFarm = false;
                log('[Inspetor de População] 👁️ OBSERVAÇÃO: Farm em ' + 
                    taxaOcupacaoFutura.toFixed(1) + '%', 'info');
            } else {
                resultado.nivelAlerta = 'normal';
                resultado.devePrioritarFarm = false;
                log('[Inspetor de População] ✓ OK: Farm seguro (' + 
                    taxaOcupacaoFutura.toFixed(1) + '% | Margem: ' + resultado.margemSegura + ' pop)', 'info');
            }

            // Regra de ouro: Se déficit > 0, Quartel/Estábulo DEVEM parar imediatamente
            if (resultado.deficit > 0) {
                log('[Inspetor de População] 🛑 IDLE MILITAR = MORTE: Interromper recrutamento e subir Farm!', 'error');
            }

        } catch (e) {
            log('[Inspetor de População] Erro: ' + e.message, 'error');
            resultado.devePrioritarFarm = false;
        }

        return resultado;
    }

    function inspetorDeBot(state) {
        var resultado = {
            riscoOverflow: false,
            horasParaEncher: Infinity,
            recursoGargalo: null,
            deveInterromper: false,
            tempoProximoCicloHoras: 0,
            detalhes: {}
        };

        try {
            // 1. Calcular espaço livre por recurso
            var espacoLivre = {
                wood:  state.recursos.max - (state.recursos.wood  || 0),
                stone: state.recursos.max - (state.recursos.stone || 0),
                iron:  state.recursos.max - (state.recursos.iron  || 0)
            };

            // 2. Taxa de produção por hora (já disponível em state.producao)
            var producaoPorHora = {
                wood:  state.producao.wood  || 0,
                stone: state.producao.stone || 0,
                iron:  state.producao.iron  || 0
            };

            // 3. Calcular HorasParaEncher por recurso: (Capacidade - Estoque) / ProducaoPorHora
            ['wood', 'stone', 'iron'].forEach(function(res) {
                if (producaoPorHora[res] > 0) {
                    resultado.detalhes[res] = {
                        espacoLivre: espacoLivre[res],
                        producaoHora: producaoPorHora[res],
                        horasParaEncher: espacoLivre[res] / producaoPorHora[res]
                    };
                } else {
                    resultado.detalhes[res] = {
                        espacoLivre: espacoLivre[res],
                        producaoHora: 0,
                        horasParaEncher: Infinity
                    };
                }
            });

            // 4. Identificar o recurso que vai encher primeiro (gargalo)
            var minHoras = Infinity;
            var recursoCritico = null;
            ['wood', 'stone', 'iron'].forEach(function(res) {
                if (resultado.detalhes[res].horasParaEncher < minHoras) {
                    minHoras = resultado.detalhes[res].horasParaEncher;
                    recursoCritico = res;
                }
            });

            resultado.horasParaEncher = minHoras;
            resultado.recursoGargalo = recursoCritico;

            // 5. Calcular Tempo do Próximo Ciclo do Bot
            // Baseado no tempo restante da fila de construção + intervalo padrão
            var tempoFilaRestanteSegundos = getTempoRestanteFilaConstrucao();
            var intervaloPadraoMs = CONFIG.mainLoopInterval;
            var tempoProximoCicloMs = tempoFilaRestanteSegundos > 0 
                ? Math.min(tempoFilaRestanteSegundos * 1000 + 2000, intervaloPadraoMs)
                : intervaloPadraoMs;
            
            resultado.tempoProximoCicloHoras = tempoProximoCicloMs / 1000 / 3600;

            // 6. Decisão: Se HorasParaEncher < TempoProximoCiclo, DEVE INTERROMPER
            // Margem de segurança: 20% adicional para evitar edge cases
            var margemSeguranca = 1.2;
            if (resultado.horasParaEncher < (resultado.tempoProximoCicloHoras * margemSeguranca)) {
                resultado.riscoOverflow = true;
                resultado.deveInterromper = true;
                log('[Inspetor de Bot] ⚠️ GARGALO IMINENTE: ' + recursoCritico + 
                    ' vai encher em ' + resultado.horasParaEncher.toFixed(2) + 'h | ' +
                    'Próximo ciclo em ' + resultado.tempoProximoCicloHoras.toFixed(4) + 'h | ' +
                    'ESPAÇO LIVRE: ' + espacoLivre[recursoCritico] + ' | ' +
                    'PRODUÇÃO/h: ' + producaoPorHora[recursoCritico], 'warning');
            } else if (resultado.horasParaEncher < 4.0) {
                // Alerta preventivo se for encher em menos de 4 horas
                resultado.riscoOverflow = true;
                resultado.deveInterromper = false;
                log('[Inspetor de Bot] 📊 ALERTA: ' + recursoCritico + 
                    ' vai encher em ' + resultado.horasParaEncher.toFixed(2) + 'h', 'info');
            } else {
                log('[Inspetor de Bot] ✓ OK: Armazém seguro por ' + resultado.horasParaEncher.toFixed(2) + 'h (' + recursoCritico + ')', 'info');
            }

        } catch (e) {
            log('[Inspetor de Bot] Erro: ' + e.message, 'error');
            resultado.riscoOverflow = false;
            resultado.deveInterromper = false;
        }

        return resultado;
    }

    // ============================================================
    // TEMPO RESTANTE DA FILA DE CONSTRUÇÃO
    // Varre a fila de construção e retorna o tempo em segundos até a próxima conclusão
    // ============================================================
    function getTempoRestanteFilaConstrucao() {
        var minSegundos = Infinity;
        try {
            var timers = document.querySelectorAll(
                '#build_queue tr .timer, #build_queue .timer, ' +
                '.lit-item .timer, .buildqueue_container .timer, ' +
                '.timer:not(.finished)'
            );
            timers.forEach(function(el) {
                var s = timeToSeconds(el.textContent.trim());
                if (s > 0 && s < minSegundos) {
                    minSegundos = s;
                }
            });
        } catch (e) {
            log('[fila-tempo] Erro: ' + e.message, 'warning');
        }
        return minSegundos === Infinity ? 0 : minSegundos;
    }

function motorDeDecisaoMacro(state, villageId) {
        var tasks = [];
        var maxFila = (state.premium && state.premium.ativo) ? 5 : 2;

        // Carregar memória da aldeia
        var memory = VillageMemory.get(villageId);

        var visHUD = { fase: state.phase, gargalo: 'OK', meta: 'Calculando...', acao: 'Monitorando', motivo: 'Ativo' };

        // ==========================================
        // [MÁQUINA DE ESTADOS LC RUSH] - CAMINHO CRÍTICO
        // ==========================================
        // Se o perfil for LC_RUSH, ignora pesos e segue estados rígidos
        var isLCRush = (memory.profile === 'lc_rush' || memory.profile === 'LC_RUSH');
        var lcState = null;
        var currentPoints = parseInt(memory.points || state.points || 0);
        
        if (isLCRush) {
            log('[LC Rush] 🎯 Modo LC Rush ativado - Seguindo caminho crítico!', 'info');
            
            // Determinar estado atual baseado nos pontos
            for (var stateKey in LC_PATH_STATES) {
                var s = LC_PATH_STATES[stateKey];
                if (currentPoints >= s.pointsRange[0] && currentPoints < s.pointsRange[1]) {
                    lcState = s;
                    break;
                }
            }
            
            if (lcState) {
                visHUD.meta = '[LC RUSH] ' + lcState.label;
                log('[LC Rush] Estado atual: ' + lcState.label, 'info');
                
                // Mostrar regras do estado atual
                if (lcState.rules) {
                    lcState.rules.forEach(function(rule) {
                        log('[LC Rush] Regra: ' + rule, 'warning');
                    });
                }
            }
        }
        // ==========================================

        // Verificar se deve mudar estratégia por falhas consecutivas
        if (VillageMemory.needsStrategyChange(villageId)) {
            log('[motorDeDecisao] Muitas falhas consecutivas, ajustando estratégia', 'warning');
            visHUD.gargalo = 'AJUSTE';
            visHUD.motivo = 'Falhas consecutivas detectadas';
        }

        // Obter pesos estratégicos baseados no perfil da aldeia (substitui profile do jogador)
        // Se estiver em LC Rush, usa pesos específicos do LC_RUSH
        var profileWeights = isLCRush 
            ? STRATEGIES['LC_RUSH'] 
            : VillageMemory.getStrategyWeights(villageId);

        // Processar observações de aprendizado pendentes (finaliza builds com > 30 min)
        var _learnProd = (state.producao.wood || 0) + (state.producao.stone || 0) + (state.producao.iron || 0);
        LearningEngine.tick(villageId, _learnProd);

        // Detectar estagnação de cluster: armazém cheio + fila cheia = perda passiva
        var _stagnation = VillageCoordinator.checkStagnation(state);
        if (_stagnation === 'critical') {
            log('[cluster] ⚠️ ESTAGNAÇÃO CRÍTICA: recursos > 95% E fila cheia — considere construir storage ou enviar recursos', 'warning');
            visHUD.gargalo = 'ESTAGNAÇÃO';
            visHUD.motivo  = 'Armazém quase cheio com fila lotada — recursos sendo desperdiçados';
        } else if (_stagnation === 'warning') {
            log('[cluster] ℹ️ Estagnação leve: recursos > 85% com fila cheia', 'info');
        }

        // TRAVA GLOBAL DE HQ (Manual 2026) — avaliada uma vez, aplicada em todos os blocos
        // HQ só sobe além de nível 15 em EARLY depois que Estábulo E Ferreiro existirem (≥ 1)
        var _hqLvl     = parseInt(state.niveis['main']   || 0);
        var _stLvl     = parseInt(state.niveis['stable'] || 0);
        var _smLvl     = parseInt(state.niveis['smith']  || 0);
        var _HQ_LOCKED = (state.phase === 'EARLY' && _hqLvl >= 10 && (_stLvl < 1 || _smLvl < 1));
        if (_HQ_LOCKED) {
            log('[estratégia] HQ TRAVADO GLOBALMENTE (Nv.' + _hqLvl + '): aguardando Estábulo/Ferreiro', 'warning');
        }

        // 1. RUSH GRÁTIS (Sempre primeiro)
        var _rushIds = state.rushIds || [];
        if (_rushIds.length > 0) {
            log('[rush] ' + _rushIds.length + ' obra(s) para rush: [' + _rushIds.join(', ') + ']', 'success');
            _rushIds.forEach(id => tasks.push({ id: 'build_rush', action: 'DO', orderId: id }));
            visHUD.acao = "RUSH OBRA"; visHUD.motivo = "Limpando fila.";
            HUD.set('build_general', 'running', 'Finalizando obras');
            HUD.updateDiagnostics(visHUD.fase, visHUD.gargalo, visHUD.meta, visHUD.acao, visHUD.motivo);
            return Promise.resolve(tasks);
        }

        if (state.knightRushId) {
            log('[rush] Paladino para rush: ID=' + state.knightRushId, 'success');
            tasks.push({ id: 'knight_rush', action: 'DO', knightId: state.knightRushId });
            visHUD.acao = "RUSH PALADINO"; visHUD.motivo = "Finalizando herói!";
            HUD.set('knight', 'running', 'Recrutamento em rush');
            HUD.updateDiagnostics(visHUD.fase, visHUD.gargalo, visHUD.meta, visHUD.acao, visHUD.motivo);
            return Promise.resolve(tasks);
        }

        // 2. BANDEIRA (Se não houver nenhuma ativa)
        if (!state.flagAssigned) {
            var _flags = state.flags || [];
            // Contexto estratégico para scoring: perfil + milestone (ciclo anterior) + situação econômica
            var _flagPct = {
                wood:  state.recursos.wood  / (state.recursos.max || 1),
                stone: state.recursos.stone / (state.recursos.max || 1),
                iron:  state.recursos.iron  / (state.recursos.max || 1)
            };
            var _flagCtx = {
                profile:        memory.profile,
                phase:          state.phase,
                milestoneId:    memory.currentMilestone,
                taxaPop:        state.populacao.max > 0 ? state.populacao.current / state.populacao.max : 0,
                riscoArmazem:   _flagPct.wood > 0.90 || _flagPct.stone > 0.90 || _flagPct.iron > 0.90,
                recursosPercent: _flagPct
            };
            var best = _flags.slice().sort(function(a, b) {
                return scoreFlagStrategic(b, _flagCtx) - scoreFlagStrategic(a, _flagCtx);
            })[0];
            if (best) {
                tasks.push({ id: 'flag', action: 'DO', reason: "Ativando " + best.category, ctx: _flagCtx });
                visHUD.acao = "BANDEIRA";
                visHUD.motivo = "Flag: " + best.category + " [" + (memory.profile || 'balanced') + "]";
                HUD.set('flag', 'running', 'Selecionando categoria');
            } else {
                HUD.set('flag', 'idle', 'Sem bandeiras disponíveis');
            }
        } else {
            HUD.set('flag', 'done', 'Bandeira ativa');
        }

        // 3. PALADINO (Com trava de erro do servidor + memória)
        var pBlock = GM_getValue('knight_blocked_' + state.villageId, 0);

        // Verificar se estátua foi construída (nível >= 1) mas paladino ainda não está presente
        // Isso pode ocorrer quando estátua foi finalizada mas paladino morreu/foi expulso
        var _knight = state.knight || {};
        var statueBuilt = state.statueEnabled && _knight.statueExists;

        if (_knight.canRecruit && Date.now() > pBlock) {
            tasks.push({ id: 'knight', action: 'DO' });
            visHUD.acao = "RECRUTAR PALADINO";
            HUD.set('knight', 'running', 'Pronto para recrutar');
        } else if (_knight.isRecruiting) {
            HUD.set('knight', 'waiting', 'Recrutando...');
        } else if (!_knight.isPresent && !statueBuilt) {
            // Estátua ainda não foi construída
            HUD.set('knight', 'idle', 'Estátua não construída');
        } else if (!_knight.isPresent && statueBuilt) {
            if (Date.now() > pBlock) {
                tasks.push({ id: 'knight', action: 'DO' });
                visHUD.acao = "REVIVER PALADINO";
                HUD.set('knight', 'running', 'Revivendo herói');
            } else {
                HUD.set('knight', 'waiting', 'Aguardando cooldown');
            }
        } else {
            HUD.set('knight', 'done', 'Paladino ativo');
        }

        // 4. DESBLOQUEIO DE COLETAS (SCAVENGE) - Opcional, controlado por CONFIG.autoUnlockScavenge
        if (CONFIG.autoUnlockScavenge) {
            log('[scavenge] Verificação automática de coletas bloqueadas habilitada', 'info');
            tasks.push({ id: 'unlock_scavenge', action: 'DO' });
            HUD.set('scavenge', 'running', 'Verificando...');
        } else {
            HUD.set('scavenge', 'idle', 'Auto desbloqueio OFF');
        }

        // 4. MARCOS ESTRATÉGICOS (Milestones) - roadmap global + perfil da aldeia
        // Fundações globais vêm primeiro; depois o caminho diverge por perfil
        var _profilePath    = MILESTONES_BY_PROFILE[memory.profile] || MILESTONES_BY_PROFILE.balanced;
        var _allMilestones  = MILESTONES_GLOBAL.concat(_profilePath);
        var activeMilestone = _allMilestones.find(function(m) {
            for (var ed in m.reqs) {
                if (state.niveis[ed] === undefined) continue;
                if (parseInt(state.niveis[ed] || 0) < m.reqs[ed]) return true;
            }
            return false;
        });

        // Persistir milestone atual na memória
        if (activeMilestone) {
            visHUD.meta = '[' + (memory.profile || 'balanced') + '] ' + activeMilestone.label;
            if (memory.currentMilestone !== activeMilestone.id) {
                VillageMemory.set(villageId, 'currentMilestone', activeMilestone.id);
            }
        } else {
            visHUD.meta = '[' + (memory.profile || 'balanced') + '] Otimização';
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
            var selectedTier = 'P4';
            var selectedScoreMargin = 0;
            var selectedAlternative = null;
            var taxaPop = (state.populacao.current / (state.populacao.max || 1)) * 100;
            // ==========================================
            // [GARFO DE POPULAÇÃO] INSPETOR DE FILA DE TREINAMENTO
            // ==========================================
            // Lê a fila de recrutamento do Quartel/Estábulo e calcula População Futura
            // Se População Futura >= Limite da Fazenda, Farm é prioridade ZERO
            var queueInfo = getTrainingQueueInfo(state._mainDoc);
            var inspecaoPopulacao = inspetorDePopulacao(state, queueInfo);

            // ==========================================
            // SISTEMA PROATIVO DE FARM - 4 NÍVEIS DE ALERTA
            // ==========================================
            // 82% → observação | 88% → preparação | 92% → prioridade alta | 95%+ → emergência
            var nivelAlertaFarm = inspecaoPopulacao.nivelAlerta;
            
            // Sobrescrever nível de alerta se o inspetor de população detectar déficit
            if (inspecaoPopulacao.devePriorizarFarm) {
                nivelAlertaFarm = inspecaoPopulacao.nivelAlerta === 'emergencia' ? 'emergencia' : 'prioridade_alta';
                log('[Garfo de População] 🎯 FARM PRIORIZADO: Déficit iminente detectado!', 'warning');
            }

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

            // [Inspetor de Bot Ativado] - Verificação crítica de gargalo
            var inspecaoBot = inspetorDeBot(state);
            
            // Se o inspetor detectar que deve interromper, força riscoArmazem para TRUE
            if (inspecaoBot.deveInterromper) {
                riscoArmazem = true;
                log('[Inspetor de Bot] 🚨 AÇÃO NECESSÁRIA: Interromper fila normal e priorizar ' + 
                    (inspecaoBot.recursoGargalo === 'storage' ? 'ARMAZÉM' : 'MINA DE ' + inspecaoBot.recursoGargalo.toUpperCase()), 'error');
            }

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

            // Tempo até overflow por recurso individual — decisor primário de risco.
            // Calculado para todos os recursos (não só os acima de 80%).
            var tempoAteOverflow = { wood: 999, stone: 999, iron: 999 };
            ['wood', 'stone', 'iron'].forEach(function(res) {
                var _prod = state.producao[res] || 0;
                var _cap  = state.recursos.max - (state.recursos[res] || 0);
                if (_prod > 0) tempoAteOverflow[res] = _cap / _prod;
            });

            // Ajustar tempo individual por loot e rewards esperados.
            // Distribuição proporcional ao peso atual de cada recurso — individual prevalece sobre agregado.
            if (lootEsperado > 0 || rewardsEsperados > 0) {
                var _totalRes    = (state.recursos.wood || 0) + (state.recursos.stone || 0) + (state.recursos.iron || 0);
                var _influxoTotal = lootEsperado + rewardsEsperados;
                ['wood', 'stone', 'iron'].forEach(function(res) {
                    var _ratio      = _totalRes > 0 ? (state.recursos[res] || 0) / _totalRes : 1 / 3;
                    var _influxoH   = (_influxoTotal * _ratio) / 24;
                    var _capRest    = state.recursos.max - (state.recursos[res] || 0);
                    var _prodTotal  = (state.producao[res] || 0) + _influxoH;
                    if (_prodTotal > 0) {
                        var _t = _capRest / _prodTotal;
                        if (_t < tempoAteOverflow[res]) tempoAteOverflow[res] = _t;
                    }
                });
            }

            // Tempo até gargalo = mínimo individual (não agregado)
            var tempoAteGargalo = Math.min(tempoAteOverflow.wood, tempoAteOverflow.stone, tempoAteOverflow.iron);

            // Decisor individual: recurso >95% OU algum vai encher em < 2h
            riscoArmazem = (recursosPercent.wood  > 0.95 ||
                            recursosPercent.stone > 0.95 ||
                            recursosPercent.iron  > 0.95 ||
                            tempoAteGargalo < 2.0);
            // Contexto agregado como sinal de apoio — reforça mas nunca substitui o individual
            if (!riscoArmazem && percentualProjetado > 0.90) riscoArmazem = true;

            // ==========================================
            // PRIORIDADE 0: NOBLING PREP (main ≥ 20 && smith ≥ 20)
            // Quando os pré-requisitos do milestone noble_prep estão atendidos,
            // entra em modo de acumulação: bloqueia construções não essenciais até
            // juntar NOBLE_COST_EACH × NOBLES_ALVO de cada recurso. Se o armazém
            // for insuficiente para guardar o custo de 1 nobre, constrói storage primeiro.
            // ==========================================
            var noblingPrepBlocking = false;
            var NOBLE_COST_EACH = 60000;
            var NOBLES_ALVO     = 3;
            var noblingTarget   = NOBLE_COST_EACH * NOBLES_ALVO; // 180 000 de cada recurso

            if (parseInt(state.niveis.main  || 0) >= 20
             && parseInt(state.niveis.smith || 0) >= 20) {

                var nStorageOk  = (state.recursos.max || 0) >= NOBLE_COST_EACH;
                var woodFalta   = Math.max(0, noblingTarget - (state.recursos.wood  || 0));
                var stoneFalta  = Math.max(0, noblingTarget - (state.recursos.stone || 0));
                var ironFalta   = Math.max(0, noblingTarget - (state.recursos.iron  || 0));
                var nobleReady  = woodFalta === 0 && stoneFalta === 0 && ironFalta === 0;
                var nobleProgPct = Math.min(100, Math.round(
                    ((Math.min(state.recursos.wood  || 0, noblingTarget)
                    + Math.min(state.recursos.stone || 0, noblingTarget)
                    + Math.min(state.recursos.iron  || 0, noblingTarget))
                    / (noblingTarget * 3)) * 100
                ));

                if (!nStorageOk && isBuildExecutable('storage', state, state._mainDoc)) {
                    // Armazém insuficiente: construir storage como prioridade máxima
                    selectedTarget = 'storage';
                    selectedTier = 'P_NOBLING'; selectedScoreMargin = 999;
                    visHUD.gargalo = "NOBLING: ARMAZÉM";
                    visHUD.motivo  = "Capacidade " + state.recursos.max + " < " + NOBLE_COST_EACH.toLocaleString() + " — ampliar antes de acumular";
                    HUD.set('build_general', 'running', 'Ampliando armazém (Nobling Prep)');
                    log('[nobling-prep] Storage insuficiente (' + state.recursos.max + ' < ' + NOBLE_COST_EACH + '), priorizando construção', 'info');
                } else if (nobleReady) {
                    visHUD.gargalo = "NOBLING READY";
                    visHUD.motivo  = "Recursos para " + NOBLES_ALVO + " nobres acumulados — inicie o recrutamento!";
                    HUD.set('build_general', 'done', 'Pronto para Nobling!');
                    log('[nobling-prep] PRONTO! ' + NOBLES_ALVO + ' nobres financiados. Inicie o recrutamento.', 'success');
                    // Não bloqueia: permite retomar construções normais após acumular
                } else {
                    // Em acumulação ativa: bloquear todas as construções não essenciais
                    noblingPrepBlocking = true;
                    var nobleMsg = nobleProgPct + "% | Falta W:" + Math.floor(woodFalta/1000) + "k S:" + Math.floor(stoneFalta/1000) + "k I:" + Math.floor(ironFalta/1000) + "k";
                    visHUD.gargalo = "NOBLING PREP";
                    visHUD.motivo  = nobleMsg;
                    HUD.set('build_general', 'waiting', 'Acumulando nobres (' + nobleProgPct + '%)');
                    HUD.updateDiagnostics(visHUD.fase, 'NOBLING PREP', NOBLES_ALVO + ' Nobres', 'ACUMULANDO', nobleMsg);
                    log('[nobling-prep] ' + nobleMsg, 'info');
                }
            }

            // ==========================================
            // SCORE UNIFICADO — TODAS AS DECISÕES
            // ==========================================
            // Eliminado: verificações prévias rígidas (P0, P1B, P1C, P2)
            // Tudo agora compete no mesmo score com multiplicadores de urgência
            {
                // [LC RUSH] - Se estiver em modo LC Rush, filtra candidatos pelo buildOrder do estado atual
                var lcRushCandidates = [];
                if (isLCRush && lcState && lcState.buildOrder) {
                    log('[LC Rush] Filtrando construções pelo caminho crítico...', 'info');
                    
                    // Filtrar apenas edifícios que estão no buildOrder do estado atual
                    lcState.buildOrder.forEach(function(target) {
                        var ed = target.building;
                        var targetLevel = target.level;
                        var currentLevel = parseInt(state.niveis[ed] || 0);
                        
                        // Só inclui se ainda não atingiu o nível alvo
                        if (currentLevel < targetLevel) {
                            lcRushCandidates.push({
                                building: ed,
                                targetLevel: targetLevel,
                                reason: target.reason
                            });
                            log('[LC Rush] Alvo LC: ' + ed + ' (nv.' + currentLevel + ' -> ' + targetLevel + ') - ' + target.reason, 'info');
                        }
                    });
                    
                    log('[LC Rush] ' + lcRushCandidates.length + ' edifícios no caminho crítico', 'info');
                }
                
                var todosCandidatos = Object.keys(TW_BUILDING_REQS).filter(function(ed) {
                    if (!state.podeSerConstruido[ed]) return false;
                    if (ed === 'snob') return false;
                    if ((state.niveis[ed] || 0) >= 25) return false;
                    if (ed === 'main' && _HQ_LOCKED) return false;
                    
                    // [LC RUSH] - Se estiver em modo LC Rush, só permite edifícios do caminho crítico
                    if (isLCRush && lcRushCandidates.length > 0) {
                        var isCritical = lcRushCandidates.some(function(c) { return c.building === ed; });
                        if (!isCritical) {
                            return false; // Ignora edifícios fora do caminho crítico
                        }
                    }
                    
                    return isBuildExecutable(ed, state, state._mainDoc);
                });

                if (todosCandidatos.length > 0) {
                    var nivelHQ = parseInt(state.niveis['main'] || 0);
                    var bonusHQ = HQ_PRODUCTIVITY_BONUS[nivelHQ] || 0;

                    // Produção média/hora — base para detectar mina gargalo
                    var _prodMedia = ((state.producao.wood || 0) + (state.producao.stone || 0) + (state.producao.iron || 0)) / 3;

                    var unified = todosCandidatos.map(function(ed) {
                        var nivelAtual = parseInt(state.niveis[ed] || 0);

                        // ── ROI REAL ─────────────────────────────────────────────
                        // roi = beneficio_real_por_hora / tempo_construcao_em_horas
                        // O tempo já inclui o bônus do HQ (construção mais rápida).
                        // Cada tipo de edifício tem função de benefício específica:
                        //   minas  → δ produção/h  (taxa de crescimento TW 16,3%/nível)
                        //   farm   → δ pop × prod/pop (pop extra = mais tropas = mais loot)
                        //   storage→ prod_em_risco × fator_overflow (evita perda real)
                        //   main   → tempo_economizado × prodTotal (acelera todas as obras)
                        //   demais → função calibrada por tipo (barracks, stable, smith…)
                        var roiData = calcBuildROI(ed, nivelAtual, state, tempoAteGargalo, recursosPercent);

                        // ── PESOS ESTRATÉGICOS ────────────────────────────────────
                        var pesoBase     = STRATEGIC_WEIGHT[state.phase][ed] || 1.0;
                        var ajustePerfil = profileWeights[ed] || 1.0;

                        // ── URGÊNCIA DE PRODUÇÃO (mina gargalo) ───────────────────
                        var urgênciaProdução = 1.0;
                        if (['wood', 'stone', 'iron'].includes(ed)) {
                            var _prodAtual = state.producao[ed] || 0;
                            if (_prodMedia > 0 && _prodAtual < _prodMedia * 0.60) urgênciaProdução = 1.7;
                            else if (_prodMedia > 0 && _prodAtual < _prodMedia * 0.80) urgênciaProdução = 1.3;
                            if (_prodAtual < 200) urgênciaProdução = Math.max(urgênciaProdução, 1.5);
                        }

                        // ── URGÊNCIA DE GARGALO (farm / overflow / nobling) ───────
                        var urgenciaGargalo = 1.0;
                        if (ed === 'farm') {
                            if (nivelAlertaFarm === 'emergencia')           urgenciaGargalo = 3.0;
                            else if (nivelAlertaFarm === 'prioridade_alta') urgenciaGargalo = 2.0;
                            else if (nivelAlertaFarm === 'preparacao')      urgenciaGargalo = 1.5;
                            else if (nivelAlertaFarm === 'observacao')      urgenciaGargalo = 1.2;
                        }
                        if (riscoArmazem && ['wood', 'stone', 'iron'].includes(ed)) {
                            var _uArm = tempoAteGargalo < 0.5 ? 3.0
                                      : tempoAteGargalo < 1.0 ? 2.5
                                      : tempoAteGargalo < 1.5 ? 2.0 : 1.5;
                            urgenciaGargalo = Math.max(urgenciaGargalo, _uArm);
                        }
                        if (noblingPrepBlocking && ['farm', 'storage', 'market'].includes(ed)) {
                            urgenciaGargalo = Math.max(urgenciaGargalo, 2.5);
                        }
                        // Obra rápida (<2 min com HQ) quando recursos >80%: consome antes do overflow
                        if (recursosPercent.wood > 0.80 || recursosPercent.stone > 0.80 || recursosPercent.iron > 0.80) {
                            if (roiData.constructionSecs < 120) urgenciaGargalo = Math.max(urgenciaGargalo, 2.2);
                        }

                        // ── BÔNUS MILESTONE ───────────────────────────────────────
                        var bonusMilestone = 1.0;
                        if (activeMilestone && activeMilestone.reqs[ed]) {
                            if ((activeMilestone.reqs[ed] - nivelAtual) > 0) bonusMilestone = 1.8;
                        }

                        // ── BÔNUS PRÉ-REQUISITO ───────────────────────────────────
                        var bonusPreReq = 0;
                        for (var _otherEd in TW_BUILDING_REQS) {
                            if (TW_BUILDING_REQS[_otherEd][ed] && !state.podeSerConstruido[_otherEd]) bonusPreReq += 0.2;
                        }

                        // ── SCORE FINAL ───────────────────────────────────────────
                        // score = (beneficio_real / tempo_construcao) × peso_estrategico
                        var score = roiData.roi * pesoBase * ajustePerfil * urgênciaProdução * urgenciaGargalo * bonusMilestone;
                        score += bonusPreReq;

                        // HQ: multiplicadores de milestone (ou zera se travado)
                        if (ed === 'main') {
                            if (_HQ_LOCKED)           score *= 0.0;
                            else if (nivelAtual < 5)  score *= 2.0;
                            else if (nivelAtual < 10) score *= 1.6;
                            else if (nivelAtual < 15) score *= 1.3;
                            else if (nivelAtual < 20) score *= 1.15;
                            // Fila ativa + recursos sobrando → HQ converte ociosidade em throughput
                            var _recursosSobrando = recursosPercent.wood > 0.70 && recursosPercent.stone > 0.70 && recursosPercent.iron > 0.70;
                            if (state.filaBuilds >= 1 && _recursosSobrando) score *= 1.5;
                        }

                        // RUSH DE CL
                        var _stableLvl = parseInt(state.niveis['stable'] || 0);
                        if (state.phase === 'EARLY' && _stableLvl >= 3) {
                            if (ed === 'smith' || ed === 'stable') score *= 3.5;
                            if (ed === 'iron')                     score *= 2.2;
                            if (ed === 'main' && nivelAtual >= 10) score *= 0.4;
                            else if (ed === 'main' && nivelAtual >= 5) score *= 0.65;
                        }

                        // Smith ≥5 mas estábulo ausente: boost urgente
                        var _smithPronto = parseInt(state.niveis['smith'] || 0) >= 5;
                        if (state.phase === 'EARLY' && _smithPronto && _stLvl < 1 && ed === 'stable') score *= 4.0;

                        return { ed: ed, score: score, roi: roiData.roi, roiRaw: roiData.roiRaw, roiLabel: roiData.label, constructionHours: roiData.constructionHours, learnedMult: roiData.learnedMult || 1.0 };
                    });

                    unified.sort(function(a, b) { return b.score - a.score; });
                    // Expor candidatos ao HUD para exibição e controle manual
                    HUD.setCandidates(unified.slice(0, 5));
                    selectedTarget = unified[0].ed;

                    // Tier dinâmico baseado na urgência dominante que venceu o score
                    var _onMilestone = !!(activeMilestone && activeMilestone.reqs[selectedTarget] &&
                                         (activeMilestone.reqs[selectedTarget] - parseInt(state.niveis[selectedTarget] || 0)) > 0);
                    var _winner = unified[0];

                    // Determinar tier pela urgência dominante
                    var _urgenciaDominante = 'P4'; // Score puro
                    if (nivelAlertaFarm === 'emergencia' && selectedTarget === 'farm') _urgenciaDominante = 'P0';
                    else if (noblingPrepBlocking && ['farm', 'storage', 'market'].includes(selectedTarget)) _urgenciaDominante = 'P_NOBLING';
                    else if (riscoArmazem && tempoAteGargalo < 1.5 && ['wood', 'stone', 'iron'].includes(selectedTarget)) _urgenciaDominante = 'P1B';
                    else if (nivelAlertaFarm === 'prioridade_alta' && selectedTarget === 'farm') _urgenciaDominante = 'P1C';
                    else if ((recursosPercent.wood > 0.80 || recursosPercent.stone > 0.80 || recursosPercent.iron > 0.80)) {
                        var custoWinner = TW_BUILDING_COSTS[selectedTarget] || [0, 0, 0, 0];
                        var tempoWinner = Math.floor(custoWinner[3] * Math.pow(1.1, parseInt(state.niveis[selectedTarget] || 0)));
                        if (tempoWinner < 120) _urgenciaDominante = 'P2';
                    }
                    else if (_onMilestone) _urgenciaDominante = 'P3';

                    selectedTier = _urgenciaDominante;
                    selectedScoreMargin = unified.length > 1 ? unified[0].score - unified[1].score : unified[0].score;
                    selectedAlternative = unified.length > 1 ? unified[1] : null;

                    visHUD.gargalo = _onMilestone ? "ROI + MILESTONE" : "ROI OTIMIZADO";
                    visHUD.motivo  = _onMilestone
                        ? selectedTarget + " | ROI: " + unified[0].roiLabel + " | Marco: " + activeMilestone.label
                        : selectedTarget + " | " + unified[0].roiLabel + " | " + unified[0].constructionHours.toFixed(2) + "h obra | score=" + unified[0].score.toFixed(1);
                }
            }
            // ── Override manual do HUD (pin > force > score) ──
            // Atualizar estado do pin antes de verificar
            HUD.updatePinState();
            
            if (HUD.pinnedBuilding && state.podeSerConstruido && state.podeSerConstruido[HUD.pinnedBuilding]) {
                // Verificar se pin está em COOLING (bloqueado temporariamente)
                if (HUD.pinState === 'COOLING') {
                    var remainingMs = HUD.pinCooldownUntil - Date.now();
                    var remainingMin = Math.ceil(remainingMs / 60000);
                    var remainingSec = Math.ceil(remainingMs / 1000) % 60;
                    var timeRemaining = remainingMin > 0 
                        ? remainingMin + 'min' + (remainingSec > 0 ? ' ' + remainingSec + 's' : '')
                        : remainingSec + 's';
                    
                    // Buscar próxima alternativa da lista de candidatos
                    var nextAlternative = null;
                    var nextScore = null;
                    if (HUD.candidates && HUD.candidates.length > 1) {
                        for (var i = 1; i < HUD.candidates.length; i++) {
                            var cand = HUD.candidates[i];
                            if (!VillageMemory.isTargetBlocked(villageId, cand.ed) && state.podeSerConstruido && state.podeSerConstruido[cand.ed]) {
                                nextAlternative = cand.ed;
                                nextScore = Math.round(cand.score);
                                break;
                            }
                        }
                    }
                    
                    visHUD.gargalo = HUD.pinnedBuilding.toUpperCase() + ' fixado — COOLING (' + timeRemaining + ' restando)';
                    visHUD.motivo = nextAlternative 
                        ? 'Usando: ' + nextAlternative.toUpperCase() + ' (próximo na lista, score ' + nextScore + ')'
                        : 'Aguardando desbloqueio do pin';
                    
                    selectedTarget = nextAlternative;
                    log('[HUD] 📌 Pin em COOLING, usando alternativa: ' + nextAlternative, 'warning');
                } else if (HUD.pinState === 'FAILED') {
                    visHUD.gargalo = 'PIN FALHOU - auto-liberado após 3+ bloqueios';
                    visHUD.motivo = 'Selecione um novo pin manualmente';
                    selectedTarget = null;
                } else {
                    selectedTarget = HUD.pinnedBuilding;
                    log('[HUD] 📌 Usando edifício fixado (ACTIVE): ' + selectedTarget, 'warning');
                }
            } else if (HUD.forcedTarget) {
                var _ft = HUD.forcedTarget;
                HUD.forcedTarget = null;
                if (state.podeSerConstruido && state.podeSerConstruido[_ft]) {
                    selectedTarget = _ft;
                    log('[HUD] ⚡ Override one-shot aplicado: ' + selectedTarget, 'warning');
                }
            }

            if (selectedTarget) {
                // Verificar se target foi bloqueado por falhas anteriores ou pin
                if (VillageMemory.isTargetBlocked(villageId, selectedTarget)) {
                    log('[motorDeDecisao] Target ' + selectedTarget + ' está bloqueado, buscando alternativa', 'warning');
                    
                    // Se for o pin, registrar bloqueio na máquina de estados
                    if (HUD.pinnedBuilding === selectedTarget) {
                        HUD.recordPinBlock();
                    }
                    
                    // Calcular tempo restante de bloqueio
                    var mem = VillageMemory.get(villageId);
                    var blocked = mem.blockedTargets || {};
                    var blockExpiry = blocked[selectedTarget] || 0;
                    var remainingMs = blockExpiry - Date.now();
                    var remainingMin = Math.ceil(remainingMs / 60000);
                    var remainingSec = Math.ceil(remainingMs / 1000) % 60;
                    var timeRemaining = remainingMin > 0 
                        ? remainingMin + 'min' + (remainingSec > 0 ? ' ' + remainingSec + 's' : '')
                        : remainingSec + 's';
                    
                    // Buscar próxima alternativa da lista de candidatos
                    var nextAlternative = null;
                    var nextScore = null;
                    if (HUD.candidates && HUD.candidates.length > 1) {
                        for (var i = 1; i < HUD.candidates.length; i++) {
                            var cand = HUD.candidates[i];
                            if (!VillageMemory.isTargetBlocked(villageId, cand.ed) && state.podeSerConstruido && state.podeSerConstruido[cand.ed]) {
                                nextAlternative = cand.ed;
                                nextScore = Math.round(cand.score);
                                break;
                            }
                        }
                    }
                    
                    visHUD.gargalo = selectedTarget.toUpperCase() + ' fixado — bloqueado (' + timeRemaining + ' restando)';
                    visHUD.motivo = nextAlternative 
                        ? 'Usando: ' + nextAlternative.toUpperCase() + ' (próximo na lista, score ' + nextScore + ')'
                        : 'Aguardando desbloqueio ou vaga na fila';
                    
                    selectedTarget = nextAlternative;
                }
                
                // Se ainda tiver target após desbloqueio/alternativa, adicionar à tarefa
                if (selectedTarget && !VillageMemory.isTargetBlocked(villageId, selectedTarget)) {
                    tasks.push({ id: 'build_general', action: 'DO', target: selectedTarget, tier: selectedTier, scoreMargin: selectedScoreMargin, alternative: selectedAlternative, roiExpected: unified[0].roiRaw || unified[0].roi, levelBuilt: parseInt(state.niveis[selectedTarget] || 0) + 1 });
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

        // RECOMPENSAS DE QUESTS
        // Roda sempre que o cooldown permitir — não depende de recursos insuficientes.
        // autoCollectQuestRewards trata sozinha o caso "sem recompensas disponíveis".
        var _questCooldownKey = 'twbot_quest_claim_ts_' + state.villageId;
        var _questCooldownMs  = 300000; // 5 minutos entre tentativas
        var _questCooldownOk  = (Date.now() - GM_getValue(_questCooldownKey, 0)) > _questCooldownMs;

        if (_questCooldownOk) {
            tasks.unshift({ id: 'claim_quest_rewards', action: 'DO' });
            GM_setValue(_questCooldownKey, Date.now());
            log('[motorDeDecisao] Agendando coleta de recompensas de quests (cooldown ok)', 'info');
        }

        HUD.updateDiagnostics(visHUD.fase, visHUD.gargalo, visHUD.meta, visHUD.acao, visHUD.motivo);
        return Promise.resolve(tasks);
    }

    // ============================================================
    // FUNÇÃO DE CLIQUE NO DOM PARA CONSTRUÇÃO (Alternativa ao AJAX)
    // Estratégia multi-camada: linha específica → seletores globais → fallback visual
    // ============================================================
    async function clicarBotaoConstruir(buildingName) {
        console.log(`[TWBot] 🔨 Tentando construir: ${buildingName}`);

        // 1. Estratégia Direta: Procurar pela LINHA da tabela específica do edifício
        const rowSelectors = [
            `tr[id*="${buildingName}_buildrow"]`,
            `tr#${buildingName}_buildrow_${buildingName}`,
            `tr[id^="${buildingName}_buildrow"]`
        ];

        let row = null;
        for (const rSel of rowSelectors) {
            row = document.querySelector(rSel);
            if (row) break;
        }

        let btn = null;
        let usedStrategy = "";

        // Se achou a linha, procura o botão DENTRO dela
        if (row) {
            console.log(`[TWBot] 📍 Linha da tabela encontrada para ${buildingName}. Buscando botão interno...`);
            const internalCandidates = row.querySelectorAll('a[id*="buildlink"], a.btn, input[type="submit"], button');

            for (const el of internalCandidates) {
                const isDisabled = el.classList.contains('disabled') ||
                                   el.hasAttribute('disabled') ||
                                   el.style.opacity === '0.5' ||
                                   el.parentElement?.classList.contains('disabled');

                const text = (el.innerText || el.value || "").toLowerCase();
                const isAction = text.includes('bauen') || text.includes('ausbauen') || text.includes('stufe') || el.id.includes('buildlink');

                if (!isDisabled && (isAction || el.id.includes('buildlink'))) {
                    btn = el;
                    usedStrategy = `row-specific (${row.id})`;
                    break;
                }
            }
        }

        // 2. Fallback Global
        if (!btn) {
            console.log(`[TWBot] 🔍 Linha não encontrada. Tentando seletores globais...`);
            const possibleSelectors = [
                `a[id*="${buildingName}_buildlink"]:not(.disabled)`,
                `a.btn-build[data-building="${buildingName}"]:not(.disabled)`,
                `form[id*="${buildingName}"] input[type="submit"]:not(.disabled)`,
                `td#content_value a[id*="buildlink"]:not(.disabled)`
            ];

            for (const selector of possibleSelectors) {
                btn = document.querySelector(selector);
                if (btn) {
                    usedStrategy = `global-selector (${selector})`;
                    break;
                }
            }
        }

        // 3. Fallback Visual
        if (!btn) {
            const contentArea = document.querySelector('td#content_value');
            if (contentArea) {
                const candidates = contentArea.querySelectorAll('a, input, button');
                for (const el of candidates) {
                    const text = (el.innerText || el.value || "").toLowerCase();
                    const isBuildAction = (text.includes('ausbauen') || text.includes('bauen') || text.match(/stufe\s*\d+/)) && el.offsetParent !== null;

                    if (isBuildAction && !el.classList.contains('disabled')) {
                        btn = el;
                        usedStrategy = "visual-fallback";
                        break;
                    }
                }
            }
        }

        // AÇÃO FINAL
        if (btn) {
            console.log(`[TWBot] ✅ SUCESSO! Botão encontrado via: ${usedStrategy}`);
            btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await new Promise(r => setTimeout(r, 600));

            btn.focus();
            btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            await new Promise(r => setTimeout(r, 100));
            btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
            btn.click();

            console.log(`[TWBot] 🖱️ Clique enviado para ${buildingName}`);
            return true;
        } else {
            console.warn(`[TWBot] ❌ FALHA REAL: Nenhum botão encontrado para ${buildingName}.`);
            console.warn(`[TWBot] 💡 Motivo provável: Fila cheia, recursos insuficientes ou edifício no nível máximo.`);
            return false;
        }
    }

    // ============================================================================
    // FUNÇÃO DE CONSTRUÇÃO ASSÍNCRONA - NOVA ABORDAGEM (FUNCIONA EM SEGUNDO PLANO)
    // ============================================================================
    async function tentarConstruirEdificio(nomeEdificio) {
        console.log(`[TWBot] 🏗️ Iniciando processo de construção para: ${nomeEdificio}`);

        // Obter estado atual do DOM (necessário para verificar botão e recursos em tempo real)
        // CORREÇÃO: Obter village_id do DOM/URL ao invés de Game.village_id (que pode não estar definido)
        var villageId = null;
        try {
            // Tentar obter do objeto Game se existir
            if (typeof Game !== 'undefined' && Game.village_id) {
                villageId = normalizeVillageId(Game.village_id);
            } else {
                // Fallback: extrair da URL ou do DOM
                var urlMatch = window.location.href.match(/[?&]village=(\d+)/);
                if (urlMatch) {
                    villageId = urlMatch[1]; // regex já captura apenas dígitos
                } else {
                    var villageEl = document.querySelector('#village_switch_left, #village_switch_right, .village_info .name');
                    if (villageEl && villageEl.href) {
                        var hrefMatch = villageEl.href.match(/[?&]village=(\d+)/);
                        if (hrefMatch) {
                            villageId = hrefMatch[1];
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('[TWBot] Erro ao obter village_id, tentando continuar...');
        }

        // Se não conseguiu obter village_id, tenta usar o estado coletado
        if (!villageId) {
            console.warn('[TWBot] Não foi possível obter village_id, verificando se temos estado...');
            // Em segundo plano, podemos não ter acesso ao DOM, então vamos direto para a requisição
        }

        var mainDoc = document; // Usar o documento atual

        // 1. Verificar se botão está disponível no DOM (validação rápida)
        // SE estiver em segundo plano e o DOM não estiver acessível, pula esta verificação
        var buttonAvailable = false;
        try {
            buttonAvailable = isButtonAvailable(nomeEdificio, mainDoc);
        } catch (e) {
            console.log(`[TWBot] ⚠️ DOM não acessível (segundo plano), pulando verificação visual...`);
            buttonAvailable = true; // Assume que está disponível e tenta a requisição
        }

        if (!buttonAvailable) {
            console.log(`[TWBot] ⚠️ ${nomeEdificio} botão não disponível (fila cheia, nível máximo ou sem recursos)`);
            return false;
        }

        // 2. Extrair recursos atuais do DOM (código inline baseado em collectVillageState)
        // SE estiver em segundo plano, usa os dados do estado coletado anteriormente
        var woodFromDOM = 0, stoneFromDOM = 0, ironFromDOM = 0;
        var recursosDisponiveis = false;

        try {
            var woodEl = mainDoc.querySelector('#resource_span .wood, .res .wood, #resources .wood');
            var stoneEl = mainDoc.querySelector('#resource_span .stone, .res .stone, #resources .stone');
            var ironEl = mainDoc.querySelector('#resource_span .iron, .res .iron, #resources .iron');

            if (woodEl) {
                var woodText = woodEl.textContent.trim().replace(/[,.]/g, '').replace(/[^0-9]/g, '');
                woodFromDOM = parseInt(woodText) || 0;
                recursosDisponiveis = true;
            }
            if (stoneEl) {
                var stoneText = stoneEl.textContent.trim().replace(/[,.]/g, '').replace(/[^0-9]/g, '');
                stoneFromDOM = parseInt(stoneText) || 0;
            }
            if (ironEl) {
                var ironText = ironEl.textContent.trim().replace(/[,.]/g, '').replace(/[^0-9]/g, '');
                ironFromDOM = parseInt(ironText) || 0;
            }
        } catch (e) {
            console.log(`[TWBot] ⚠️ Não foi possível ler recursos do DOM (segundo plano)`);
            recursosDisponiveis = false;
        }

        var recursosDOM = { wood: woodFromDOM, stone: stoneFromDOM, iron: ironFromDOM };

        // Obter nível atual do edifício (se DOM disponível)
        var nivelAtual = 0;
        try {
            var buildingRow = mainDoc.querySelector('#building_' + nomeEdificio);
            if (buildingRow) {
                var levelMatch = buildingRow.className.match(/level_(\d+)/);
                if (levelMatch) {
                    nivelAtual = parseInt(levelMatch[1]);
                }
            }
        } catch (e) {
            console.log(`[TWBot] ⚠️ Não foi possível obter nível do edifício (segundo plano)`);
        }

        // Verificar recursos apenas se conseguimos ler do DOM
        if (recursosDisponiveis && recursosDOM.wood > 0) {
            var custosBase = TW_BUILDING_COSTS[nomeEdificio];

            if (custosBase) {
                var custoMadeira = Math.floor(custosBase[0] * Math.pow(1.5, nivelAtual));
                var custoPedra = Math.floor(custosBase[1] * Math.pow(1.5, nivelAtual));
                var custoFerro = Math.floor(custosBase[2] * Math.pow(1.5, nivelAtual));

                if (recursosDOM.wood < custoMadeira || recursosDOM.stone < custoPedra || recursosDOM.iron < custoFerro) {
                    console.log(`[TWBot] ⚠️ ${nomeEdificio} sem recursos suficientes. Necessário: W=${custoMadeira}, S=${custoPedra}, I=${custoFerro}`);
                    return false;
                }
            }
        }

        // 3. A MÁGICA ACONTECE AQUI:
        // Tenta primeiro clicar no botão (se DOM disponível), senão faz requisição direta
        var sucesso = false;

        // Tenta encontrar e clicar o botão (funciona apenas se a página estiver carregada)
        try {
            sucesso = await clicarBotaoConstruir(nomeEdificio);
        } catch (e) {
            console.log(`[TWBot] ⚠️ Não foi possível clicar no botão via DOM, usando fallback AJAX...`);
            sucesso = false;
        }

        // Se não conseguiu clicar (segundo plano), faz requisição AJAX direta
        if (!sucesso && villageId) {
            console.log(`[TWBot] 🔄 Usando método de requisição direta para ${nomeEdificio}...`);

            // Obter CSRF do estado global ou do game_data
            var csrf = null;
            try {
                if (typeof unsafeWindow !== 'undefined' && unsafeWindow.game_data && unsafeWindow.game_data.csrf) {
                    csrf = unsafeWindow.game_data.csrf;
                } else if (typeof game_data !== 'undefined' && game_data && game_data.csrf) {
                    csrf = game_data.csrf;
                }
            } catch (e) {}

            if (!csrf) {
                console.error(`[TWBot] ❌ CSRF não disponível, não é possível construir ${nomeEdificio}`);
                return false;
            }

            // Fazer requisição direta usando bgBuildGeneric
            sucesso = await bgBuildGeneric(villageId, nomeEdificio, csrf);
        }

        if (sucesso) {
            console.log(`[TWBot] ✅ Construção de ${nomeEdificio} iniciada com sucesso!`);
            return true;
        } else {
            console.log(`[TWBot] ⏸️ Não foi possível construir ${nomeEdificio} agora. Verificando fila/recursos.`);
            return false;
        }
    }

    // Função bgBuildGeneric atualizada para ser assíncrona (usada como fallback em segundo plano)
    async function bgBuildGeneric(villageId, building, csrf) {
        var origin = window.location.origin;
        // URL correta para upgrade de edifícios no Tribal Wars (type=main é obrigatório)
        var buildUrl = origin + '/game.php?village=' + villageId + '&screen=main&ajaxaction=upgrade_building&type=main';
        var body = 'id=' + building + '&force=1&destroy=0&source=' + villageId + '&h=' + csrf;

        log('[builder] Solicitando upgrade de ' + building + '...', 'info');

        try {
            var resp = await twFetch(buildUrl, 'POST', body);
            // Usar camada de verificação robusta
            var success = verifyQueuedAfterBuild(resp, building);
            if (success) {
                log('[builder] ' + building + ' confirmado na fila!', 'success');
                // Pequeno delay para o servidor processar antes da próxima ação
                await new Promise(resolve => setTimeout(resolve, 500));
                return true;
            } else {
                log('[builder] Falha ao confirmar ' + building + ' na fila', 'error');
                // Log da resposta completa para debug
                log('[builder] Resposta recebida: ' + resp.substring(0, 200), 'warning');
                return false;
            }
        } catch(err) {
            log('[builder] Erro na requisição de ' + building + ': ' + err, 'error');
            return false;
        }
    }

    // ============================================================
    // CONSTRUIR EM SEGUNDO PLANO (AJAX FANTASMA)
    // Não procura botão no DOM. Envia POST direto ao servidor.
    // ============================================================
    function bgUpgradeBuilding(villageId, buildingName) {
        var origin = window.location.origin;
        var mainUrl = origin + '/game.php?village=' + villageId + '&screen=main';

        log('[ghost-build] Verificando ' + buildingName + '...');

        return twFetch(mainUrl, 'GET', null, false).then(function(html) {
            // CSRF: unsafeWindow > game_data > extração do HTML
            var csrf = (typeof unsafeWindow !== 'undefined' && unsafeWindow.game_data && unsafeWindow.game_data.csrf)
                ? unsafeWindow.game_data.csrf
                : ((typeof game_data !== 'undefined' && game_data && game_data.csrf)
                    ? game_data.csrf
                    : extractCsrf(html));

            if (!csrf) {
                log('[ghost-build] CSRF não encontrado!', 'error');
                HUD.set('build_general', 'error', 'Sem CSRF');
                return { ok: false, reason: 'no_csrf' };
            }

            // Sinalização textual de recursos insuficientes no HTML
            var noResText = html.indexOf('Pas assez de ressources') !== -1 ||
                            html.indexOf('not enough resources')    !== -1 ||
                            html.indexOf('recursos insuficientes')  !== -1;
            if (noResText) {
                log('[ghost-build] Recursos insuficientes para ' + buildingName + ' (texto servidor) — aguardando', 'info');
                HUD.set('build_general', 'waiting', 'Aguardando recursos para ' + buildingName);
                return { ok: false, reason: 'no_resources' };
            }

            // Validação DOM: extrair custos reais e comparar com recursos atuais
            var mainDoc = new DOMParser().parseFromString(html, 'text/html');
            var baseCosts = TW_BUILDING_COSTS[buildingName];
            var costs = extractCosts(buildingName, mainDoc, baseCosts);
            if (costs) {
                log('[ghost-build] Custos: W=' + costs.wood + ' S=' + costs.stone + ' I=' + costs.iron + (costs.fromDOM ? ' (DOM)' : ' (tabela)'), 'debug');
                var curWood = 0, curStone = 0, curIron = 0;
                try {
                    var win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
                    curWood  = parseInt(win.game_data.village.wood  || 0) || 0;
                    curStone = parseInt(win.game_data.village.stone || 0) || 0;
                    curIron  = parseInt(win.game_data.village.iron  || 0) || 0;
                } catch(e) {
                    var spW = mainDoc.querySelector('#wood, #wood_current, .wood_current');
                    var spS = mainDoc.querySelector('#stone, #stone_current, .stone_current');
                    var spI = mainDoc.querySelector('#iron, #iron_current, .iron_current');
                    curWood  = spW ? parseInt((spW.textContent || '').replace(/\D/g, '')) || 0 : 0;
                    curStone = spS ? parseInt((spS.textContent || '').replace(/\D/g, '')) || 0 : 0;
                    curIron  = spI ? parseInt((spI.textContent || '').replace(/\D/g, '')) || 0 : 0;
                }
                if ((curWood > 0 || curStone > 0 || curIron > 0) &&
                    (costs.wood > curWood || costs.stone > curStone || costs.iron > curIron)) {
                    log('[ghost-build] Recursos insuficientes para ' + buildingName + ' (validação interna) — aguardando', 'info');
                    HUD.set('build_general', 'waiting', 'Aguardando recursos para ' + buildingName);
                    // Delta detectado entre custo estimado e custo real: forçar recalibração
                    (function() {
                        var _bs = {}; try { _bs = JSON.parse(GM_getValue('twbot_build_stats', '{}') || '{}'); } catch(e) {}
                        _bs.attempts    = (_bs.attempts    || 0) + 1;
                        _bs.no_resources = (_bs.no_resources || 0) + 1;
                        if (_bs.no_resources >= 3 && _bs.no_resources / _bs.attempts > 0.3) {
                            GM_setValue('twbot_force_rescrape', 1);
                            _bs.no_resources = 0; _bs.attempts = 0; // reset após trigger
                            log('[costs-scraper] Taxa de confirmação baixa — revalidação de custos agendada', 'warning');
                        }
                        GM_setValue('twbot_build_stats', JSON.stringify(_bs));
                    })();
                    return { ok: false, reason: 'no_resources' };
                }
            }

            var buildUrl = origin + '/game.php?village=' + villageId + '&screen=main&ajaxaction=upgrade_building&type=main';
            var body = 'id=' + buildingName + '&force=1&destroy=0&source=' + villageId + '&h=' + csrf;

            HUD.set('build_general', 'running', 'Construindo ' + buildingName);

            return twFetch(buildUrl, 'POST', body).then(function(resp) {
                var success = false;
                var errorMsg = '';
                try {
                    var json = JSON.parse(resp);
                    success = !!(json.success || json.order_id);
                    if (!success && json.error) errorMsg = json.error;
                } catch (e) {
                    success = resp.indexOf('success') !== -1 || resp.indexOf('order') !== -1;
                }

                if (success) {
                    log('[ghost-build] ' + buildingName + ' enfileirado com sucesso', 'success');
                    HUD.set('build_general', 'done', buildingName + ' enfileirado!');
                    (function() {
                        var _bs = {}; try { _bs = JSON.parse(GM_getValue('twbot_build_stats', '{}') || '{}'); } catch(e) {}
                        _bs.attempts  = (_bs.attempts  || 0) + 1;
                        _bs.confirmed = (_bs.confirmed || 0) + 1;
                        GM_setValue('twbot_build_stats', JSON.stringify(_bs));
                    })();
                    return { ok: true };
                } else {
                    log('[ghost-build] Falha ao construir ' + buildingName + (errorMsg ? ': ' + errorMsg : ''), 'error');
                    HUD.set('build_general', 'error', 'Falha: ' + (errorMsg || 'sem detalhes'));
                    return { ok: false, reason: 'build_fail' };
                }
            });
        }).catch(function(e) {
            log('[ghost-build] Erro de rede: ' + e.message, 'error');
            return { ok: false, reason: 'network_error' };
        });
    }

    // ============================================================
    // EXECUTOR CANÔNICO DE BUILD — pipeline unificado
    // Substitui: bgUpgradeBuilding + bgBuildGeneric + clicarBotaoConstruir
    // plan: { villageId, building }
    // Retorna Promise<{ ok: boolean, reason: string }>
    // Estratégia: GET main (CSRF+custo) → AJAX POST → fallback DOM click
    // ============================================================
    async function executeBuildPlan(plan) {
        var villageId = plan.villageId;
        var building  = plan.building;
        var origin    = window.location.origin;
        var mainUrl   = origin + '/game.php?village=' + villageId + '&screen=main';

        log('[build] executeBuildPlan → ' + building, 'info');

        // ── Etapa 1: GET main — CSRF fresco + validação de custos ──
        var html;
        try {
            html = await twFetch(mainUrl, 'GET', null, false);
        } catch (e) {
            log('[build] Erro de rede (GET main): ' + e.message, 'error');
            return { ok: false, reason: 'network_error' };
        }

        // CSRF: unsafeWindow > game_data > extração do HTML
        var csrf = (typeof unsafeWindow !== 'undefined' && unsafeWindow.game_data && unsafeWindow.game_data.csrf)
            ? unsafeWindow.game_data.csrf
            : ((typeof game_data !== 'undefined' && game_data && game_data.csrf)
                ? game_data.csrf
                : extractCsrf(html));

        if (!csrf) {
            log('[build] CSRF não encontrado!', 'error');
            HUD.set('build_general', 'error', 'Sem CSRF');
            return { ok: false, reason: 'no_csrf' };
        }

        // Sinalização textual de recursos insuficientes no HTML
        if (html.indexOf('Pas assez de ressources') !== -1 ||
            html.indexOf('not enough resources')    !== -1 ||
            html.indexOf('recursos insuficientes')  !== -1) {
            log('[build] Recursos insuficientes para ' + building + ' (texto servidor)', 'info');
            HUD.set('build_general', 'waiting', 'Aguardando recursos para ' + building);
            return { ok: false, reason: 'no_resources' };
        }

        // Validação DOM: custos reais vs recursos atuais
        var mainDoc = new DOMParser().parseFromString(html, 'text/html');
        var baseCosts = TW_BUILDING_COSTS[building];
        var costs = extractCosts(building, mainDoc, baseCosts);
        if (costs) {
            log('[build] Custos: W=' + costs.wood + ' S=' + costs.stone + ' I=' + costs.iron + (costs.fromDOM ? ' (DOM)' : ' (tabela)'), 'debug');
            var curWood = 0, curStone = 0, curIron = 0;
            try {
                var _win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
                curWood  = parseInt(_win.game_data.village.wood  || 0) || 0;
                curStone = parseInt(_win.game_data.village.stone || 0) || 0;
                curIron  = parseInt(_win.game_data.village.iron  || 0) || 0;
            } catch(e) {
                var _spW = mainDoc.querySelector('#wood, #wood_current, .wood_current');
                var _spS = mainDoc.querySelector('#stone, #stone_current, .stone_current');
                var _spI = mainDoc.querySelector('#iron, #iron_current, .iron_current');
                curWood  = _spW ? parseInt((_spW.textContent || '').replace(/\D/g, '')) || 0 : 0;
                curStone = _spS ? parseInt((_spS.textContent || '').replace(/\D/g, '')) || 0 : 0;
                curIron  = _spI ? parseInt((_spI.textContent || '').replace(/\D/g, '')) || 0 : 0;
            }
            if ((curWood > 0 || curStone > 0 || curIron > 0) &&
                (costs.wood > curWood || costs.stone > curStone || costs.iron > curIron)) {
                log('[build] Recursos insuficientes para ' + building + ' (validação interna)', 'info');
                HUD.set('build_general', 'waiting', 'Aguardando recursos para ' + building);
                // Revalidação de custos se taxa de falha por recursos for alta
                (function() {
                    var _bs = {}; try { _bs = JSON.parse(GM_getValue('twbot_build_stats', '{}') || '{}'); } catch(e) {}
                    _bs.attempts     = (_bs.attempts     || 0) + 1;
                    _bs.no_resources = (_bs.no_resources || 0) + 1;
                    if (_bs.no_resources >= 3 && _bs.no_resources / _bs.attempts > 0.3) {
                        GM_setValue('twbot_force_rescrape', 1);
                        _bs.no_resources = 0; _bs.attempts = 0;
                        log('[build] Taxa de confirmação baixa — revalidação de custos agendada', 'warning');
                    }
                    GM_setValue('twbot_build_stats', JSON.stringify(_bs));
                })();
                return { ok: false, reason: 'no_resources' };
            }
        }

        // ── Etapa 2: AJAX ghost-build (caminho primário) ──
        var buildUrl = origin + '/game.php?village=' + villageId + '&screen=main&ajaxaction=upgrade_building&type=main';
        var body     = 'id=' + building + '&force=1&destroy=0&source=' + villageId + '&h=' + csrf;

        HUD.set('build_general', 'running', 'Construindo ' + building);

        var ajaxOk = false;
        var errorMsg = '';
        try {
            var resp = await twFetch(buildUrl, 'POST', body);
            try {
                var json = JSON.parse(resp);
                ajaxOk = !!(json.success || json.order_id);
                if (!ajaxOk && json.error) errorMsg = json.error;
            } catch (e) {
                ajaxOk = resp.indexOf('success') !== -1 || resp.indexOf('order') !== -1;
            }
        } catch (e) {
            log('[build] Erro de rede (AJAX POST): ' + e.message, 'error');
        }

        if (ajaxOk) {
            log('[build] ' + building + ' enfileirado via AJAX', 'success');
            HUD.set('build_general', 'done', building + ' enfileirado!');
            (function() {
                var _bs = {}; try { _bs = JSON.parse(GM_getValue('twbot_build_stats', '{}') || '{}'); } catch(e) {}
                _bs.attempts  = (_bs.attempts  || 0) + 1;
                _bs.confirmed = (_bs.confirmed || 0) + 1;
                GM_setValue('twbot_build_stats', JSON.stringify(_bs));
            })();
            VillageMemory.recordSuccess(villageId, building);
            return { ok: true, reason: 'ajax' };
        }

        // ── Etapa 3: Fallback — clique DOM ──
        log('[build] AJAX falhou (' + (errorMsg || 'sem detalhes') + ') — fallback DOM click...', 'warning');
        var domOk = false;
        try {
            domOk = await clicarBotaoConstruir(building);
        } catch (e) {
            log('[build] Erro no clique DOM: ' + e.message, 'error');
        }

        if (domOk) {
            log('[build] ' + building + ' enfileirado via clique DOM', 'success');
            HUD.set('build_general', 'done', building + ' enfileirado (DOM)!');
            VillageMemory.recordSuccess(villageId, building);
            return { ok: true, reason: 'dom_click' };
        }

        // ── Falha total ──
        log('[build] Falha total para ' + building + (errorMsg ? ': ' + errorMsg : ''), 'error');
        HUD.set('build_general', 'error', 'Falha: ' + (errorMsg || 'sem detalhes'));
        VillageMemory.recordError(villageId, building, 'build_fail');
        return { ok: false, reason: 'build_fail' };
    }

   // ============================================================
    // MAIN CHECKLIST ORCHESTRATOR - O CORAÇÃO DO BOT (V5.2)
    // ============================================================
   function bgBuildRush(villageId, orderId, csrf) {
        // Busca o CSRF mais atualizado diretamente do objeto do jogo para não usar token velho
        var activeCsrf = (typeof unsafeWindow !== 'undefined' && unsafeWindow.game_data)
            ? unsafeWindow.game_data.csrf
            : (typeof game_data !== 'undefined' && game_data ? game_data.csrf : csrf);

        var url = window.location.origin + '/game.php?village=' + villageId + '&screen=main&ajaxaction=build_order_reduce&h=' + activeCsrf + '&id=' + orderId + '&destroy=0';

        return twFetch(url, 'GET').then(resp => {

            try {
                var json = JSON.parse(resp);
                if (json.success) {
                    log('[rush] SUCESSO! Construção ' + orderId + ' finalizada instantaneamente!', 'success');
                    HUD.set('build_general', 'done', 'Rush completado!');
                    return true;
                } else if (json.error) {
                    log('[rush] ERRO do servidor: ' + json.error, 'error');
                    HUD.set('build_general', 'error', 'Rush falhou: ' + json.error);
                    return false;
                } else {
                    log('[rush] Resposta JSON sem success/error: ' + JSON.stringify(json), 'warning');
                    return false;
                }
            } catch (e) {
                // Se não for JSON, verifica se a página retornou sucesso por texto
                if (resp.indexOf('success') !== -1 || resp.indexOf('Construção finalizada') !== -1) {
                    log('[rush] SUCESSO (texto)! Construção finalizada.', 'success');
                    return true;
                } else {
                    log('[rush] Falha ao finalizar rush. Resposta não-JSON: ' + resp.substring(0, 100), 'error');
                    HUD.set('build_general', 'error', 'Rush falhou (resposta inválida)');
                    return false;
                }
            }
        }).catch(function(err) {
            log('[rush] ERRO DE REDE/EXCEPTION: ' + err.message, 'error');
            HUD.set('build_general', 'error', 'Erro de rede no rush');
            return false;
        });
    }
    function bgRushKnight(villageId, knightId, csrf) {
        var origin = window.location.origin;
        var activeCsrf = (typeof unsafeWindow !== 'undefined' && unsafeWindow.game_data)
            ? unsafeWindow.game_data.csrf
            : (typeof game_data !== 'undefined' && game_data ? game_data.csrf : csrf);

        log('[knight-rush] Disparando rush no paladino ID: ' + knightId, 'info');
        HUD.set('knight', 'running', 'Finalizando paladino...');

        var rushUrl  = origin + '/game.php?village=' + villageId + '&screen=statue&ajaxaction=recruit_rush';
        var rushBody = 'knight=' + knightId + '&home=' + villageId + '&h=' + activeCsrf;

        return twFetch(rushUrl, 'POST', rushBody).then(function(resp) {
            try {
                var json = JSON.parse(resp);
                if (json.success) {
                    log('[knight-rush] Paladino finalizado instantaneamente!', 'success');
                    GM_setValue('knight_done_' + villageId, Date.now());
                    HUD.set('knight', 'done', 'Recrutado!');
                    return true;
                }
                log('[knight-rush] Servidor recusou rush: ' + JSON.stringify(json).slice(0, 100), 'warning');
                return false;
            } catch (e) {
                if (resp.indexOf('success') !== -1) {
                    log('[knight-rush] Rush concluído (texto).', 'success');
                    return true;
                }
                log('[knight-rush] Resposta inválida: ' + resp.slice(0, 80), 'error');
                return false;
            }
        }).catch(function(err) {
            log('[knight-rush] Erro de rede: ' + err.message, 'error');
            return false;
        });
    }

    // ============================================================
    // RECOMPENSAS DE QUESTS — coleta automática com proteção contra overflow
    // Método baseado em interceptador: busca AJAX direta sem abrir modal
    // ============================================================

    /**
     * Função auxiliar de delay (evita ban por flood)
     */
    function sleep(ms) {
        return new Promise(function(resolve) { setTimeout(resolve, ms); });
    }

    /**
     * Passo 1: Busca o HTML do modal do Quest em segundo plano via AJAX
     * URL exata capturada pelo interceptador: GET com headers específicos
     */
    function fetchQuestDialog(villageId) {
        var origin = window.location.origin;
        var url = origin + '/game.php?village=' + villageId + '&screen=new_quests&ajax=quest_popup&tab=main-tab&quest=0';

        log('[quest-rewards] FetchQuestDialog: Solicitando ' + url, 'info');

        return new Promise(function(resolve) {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                    'TribalWars-Ajax': '1',
                    'Accept': 'application/json'
                },
                withCredentials: true,
                onload: function(res) {
                    log('[quest-rewards] FetchQuestDialog response:', 'info');
                    log('  - status: ' + res.status, 'info');
                    log('  - length: ' + (res.responseText ? res.responseText.length : 0) + ' chars', 'info');

                    try {
                        var data = JSON.parse(res.responseText || '{}');
                        if (data.response && data.response.dialog) {
                            log('[quest-rewards] Dialog extraído com sucesso (' + data.response.dialog.length + ' chars)', 'success');
                            resolve(data.response.dialog);
                        } else {
                            log('[quest-rewards] Resposta não continha dialog: ' + JSON.stringify(data).slice(0, 200), 'warning');
                            resolve(null);
                        }
                    } catch (e) {
                        log('[quest-rewards] Erro ao parsear JSON: ' + e.message, 'error');
                        resolve(null);
                    }
                },
                onerror: function(e) {
                    log('[quest-rewards] Erro na requisição: ' + JSON.stringify(e), 'error');
                    resolve(null);
                }
            });
        });
    }

    /**
     * Passo 2: Coleta a recompensa usando o reward_id extraído
     * URL e body exatos capturados pelo interceptador (POST)
     */
    function claimReward(villageId, csrf, rewardId) {
        var origin = window.location.origin;
        var url = origin + '/game.php?village=' + villageId + '&screen=new_quests&ajax=claim_reward';

        var bodyParams = 'reward_id=' + encodeURIComponent(rewardId) + '&h=' + encodeURIComponent(csrf);

        log('[quest-rewards] ClaimReward: Coletando reward_id=' + rewardId, 'info');

        return new Promise(function(resolve) {
            GM_xmlhttpRequest({
                method: 'POST',
                url: url,
                headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                    'TribalWars-Ajax': '1',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json'
                },
                withCredentials: true,
                data: bodyParams,
                onload: function(res) {
                    log('[quest-rewards] ClaimReward response:', 'info');
                    log('  - status: ' + res.status, 'info');
                    log('  - response: ' + (res.responseText ? res.responseText.substring(0, 150) : 'vazio'), 'info');

                    try {
                        var data = JSON.parse(res.responseText || '{}');
                        resolve(data);
                    } catch (e) {
                        log('[quest-rewards] Erro ao parsear resposta: ' + e.message, 'warning');
                        resolve({ error: 'Parse error', raw: res.responseText });
                    }
                },
                onerror: function(e) {
                    log('[quest-rewards] Erro na requisição: ' + JSON.stringify(e), 'error');
                    resolve(null);
                }
            });
        });
    }

    /**
     * Parseia o HTML do popup de quests (screen=new_quests&ajax=quest_popup)
     * e retorna lista de recompensas disponíveis com seus IDs e quantidades de recursos.
     * Suporta resposta JSON ou HTML (estrutura TW 10.x).
     */
    function parseQuestRewards(html) {
        if (!html) {
            log('[quest-rewards] Parse: HTML vazio', 'warning');
            return [];
        }

        // Verifica se é JSON de redirecionamento (problema principal)
        if (html.trim().startsWith('{')) {
            try {
                var jsonCheck = JSON.parse(html);
                if (jsonCheck.redirect) {
                    log('[quest-rewards] Parse: Recebeu redirect em vez de HTML — sessão inválida ou requisição não AJAX: ' + jsonCheck.redirect, 'error');
                    return [];
                }
            } catch(e) {}
        }

        // Log do tamanho e preview do HTML para diagnóstico
        var preview = html.length > 300 ? html.slice(0, 300).replace(/\s+/g, ' ') : html.replace(/\s+/g, ' ');
        log('[quest-rewards] Parse: HTML recebido (' + html.length + ' chars): ' + preview, 'info');

        var rewards = [];

        // Tentativa 1: JSON direto (estrutura de rewards)
        try {
            var json = JSON.parse(html);
            var list = json.rewards || json.quest_rewards || json.data || json.items || [];
            if (Array.isArray(list)) {
                var mapped = list.map(function(r) {
                    return {
                        id:    String(r.reward_id || r.id || r.quest_id || ''),
                        wood:  parseInt(r.wood  || (r.resources && r.resources.wood)  || 0) || 0,
                        stone: parseInt(r.stone || (r.resources && r.resources.stone) || 0) || 0,
                        iron:  parseInt(r.iron  || (r.resources && r.resources.iron)  || 0) || 0
                    };
                }).filter(function(r) { return r.id; });
                if (mapped.length) {
                    log('[quest-rewards] Parse: JSON direto encontrou ' + mapped.length + ' recompensas', 'success');
                    return mapped;
                }
            }
        } catch(e) {
            log('[quest-rewards] Parse: Não é JSON válido (' + e.message + ')', 'info');
        }

        // Tentativa 2: HTML parsing ampliado (nova estrutura TW)
        var doc = new DOMParser().parseFromString(html, 'text/html');

        // Debug: verificar se há elementos conhecidos no HTML
        var hasRewardElements = doc.querySelectorAll('.quest-reward, .reward-item, [data-reward-id], form[action*="claim"], .reward-row, tr.reward, a[href*="reward_id"]').length > 0;
        log('[quest-rewards] Parse: Elementos de reward no HTML? ' + hasRewardElements, hasRewardElements ? 'info' : 'warning');

        doc.querySelectorAll('.quest-reward, .reward-item, [data-reward-id], form[action*="claim"], .reward-row, tr.reward').forEach(function(el) {
            var idInput = el.querySelector('input[name="reward_id"], input[name="id"]');
            var formInput = el.closest && el.closest('form') && el.closest('form').querySelector('input[name="reward_id"]');
            var id = el.getAttribute('data-reward-id')
                  || (idInput && idInput.value)
                  || (formInput && formInput.value);
            if (!id) {
                var a = el.href ? el : (el.querySelector && el.querySelector('a'));
                var m = a && (a.href || '').match(/reward_id=(\d+)/i);
                if (m) id = m[1];
            }
            if (!id || isNaN(id)) return;
            var res = { wood: 0, stone: 0, iron: 0 };
            ['wood', 'stone', 'iron'].forEach(function(type) {
                el.querySelectorAll('.' + type + ', [class*="' + type + '"], .res_' + type).forEach(function(e) {
                    var n = parseInt((e.textContent || '').replace(/[^0-9]/g, '')) || 0;
                    if (n > res[type]) res[type] = n;
                });
            });
            rewards.push({ id: String(id), wood: res.wood, stone: res.stone, iron: res.iron });
        });

        // Tentativa 3: fallback — qualquer link com reward_id
        if (rewards.length === 0) {
            doc.querySelectorAll('a[href*="reward_id="]').forEach(function(el) {
                var m = (el.href || '').match(/reward_id=(\d+)/i);
                if (m) rewards.push({ id: m[1], wood: 0, stone: 0, iron: 0 });
            });
        }

        // Tentativa 4: buscar por onclick com claimReward ou similar (regex melhorado)
        if (rewards.length === 0) {
            doc.querySelectorAll('[onclick*="reward_id"], [onclick*="claimReward"]').forEach(function(el) {
                var onclick = el.getAttribute('onclick') || '';
                // Tenta múltiplos padrões
                var patterns = [
                    /reward_id['\"]?\s*[:=]\s*['\"]?(\d+)/i,
                    /claimReward\s*\(\s*['\"]?(\d+)/i,
                    /['\"](\d+)['\"]/
                ];
                for (var i = 0; i < patterns.length; i++) {
                    var m = onclick.match(patterns[i]);
                    if (m && m[1]) {
                        var id = m[1];
                        if (id && !rewards.find(function(r) { return r.id === id; })) {
                            rewards.push({ id: String(id), wood: 0, stone: 0, iron: 0 });
                        }
                        break;
                    }
                }
            });
        }

        log('[quest-rewards] Parse: ' + rewards.length + ' recompensas encontradas', rewards.length ? 'success' : 'warning');
        if (rewards.length > 0) {
            log('[quest-rewards] IDs encontrados: [' + rewards.map(function(r) { return r.id; }).join(', ') + ']', 'info');
        }
        return rewards;
    }

    /**
     * Reivindica as recompensas de quests que NÃO causariam overflow no armazém.
     * MÉTODO PRINCIPAL: Usa twFetch com AJAX nativo para buscar o modal em segundo plano
     * e extrair os reward_ids diretamente do JSON/HTML. Muito mais rápido e confiável.
     */
    // ============================================================
    // QUEST REWARDS — método confirmado 100% funcional:
    // 1. GET direto na página completa screen=new_quests (background)
    // 2. Extrai reward_ids do HTML completo
    // 3. POST ajax=claim_reward → body: reward_id={id}&h={csrf}
    // ============================================================
    function bgClaimQuestRewards(villageId, csrf, cachedRewards) {
        log('[quest-rewards] === INICIANDO CLAIM BG === village=' + villageId, 'info');
        HUD.set('build_general', 'running', 'Coletando recompensas de quests...');

        var origin = window.location.origin;
        // Buscar HTML COMPLETO da página de quests
        var fullPageUrl = origin + '/game.php?village=' + villageId + '&screen=new_quests';
        var rewardTabUrl = origin + '/game.php?village=' + villageId + '&screen=new_quests&ajax=quest_popup&tab=reward-tab';
        var claimUrl = origin + '/game.php?village=' + villageId + '&screen=new_quests&ajax=claim_reward';

        log('[quest-rewards] URL alvo (página completa): ' + fullPageUrl, 'info');
        log('[quest-rewards] CSRF disponível: ' + (csrf ? 'sim' : 'não'), 'info');

        // Passo 1: GET na página COMPLETA de quests para obter hash
        return new Promise(function(resolve) {
            log('[quest-rewards] Enviando GM_xmlhttpRequest para página completa...', 'info');

            var cookies = document.cookie || '';
            log('[quest-rewards] Cookies disponíveis: ' + (cookies ? cookies.length : 0) + ' chars', 'info');

            GM_xmlhttpRequest({
                method: 'GET',
                url: fullPageUrl,
                headers: {
                    'Accept': 'text/html,application/xhtml+xml',
                    'Referer': origin + '/game.php?village=' + villageId + '&screen=overview',
                    'Cookie': cookies
                },
                withCredentials: true,
                onload: function(res) {
                    log('[quest-rewards] GET response:', 'info');
                    log('  - status: ' + res.status + ' ' + res.statusText, 'info');
                    log('  - finalURL: ' + (res.finalUrl || 'N/A'), 'info');
                    log('  - length: ' + (res.responseText ? res.responseText.length : 0) + ' chars', 'info');
                    log('  - starts with {: ' + (res.responseText && res.responseText.trim().startsWith('{')), 'info');
                    if (res.responseText && res.responseText.length > 20) {
                        log('[quest-rewards] GET preview: ' + res.responseText.substring(0, 200).replace(/\s+/g, ' '), 'info');
                    }
                    resolve(res.responseText || '');
                },
                onerror: function(e) {
                    log('[quest-rewards] GET error: ' + JSON.stringify(e), 'error');
                    resolve('');
                }
            });
        }).then(function(html) {
            // Diagnóstico detalhado do HTML recebido
            log('[quest-rewards] === DIAGNÓSTICO DO HTML ===', 'info');
            log('  - HTML recebido: ' + (html ? html.length : 0) + ' chars', 'info');
            log('  - É JSON redirect: ' + (html && html.includes('"redirect"')), 'info');
            log('  - Contém quest-popup: ' + (html && html.includes('quest-popup')), 'info');
            log('  - Contém reward: ' + (html && html.includes('reward')), 'info');

            if (!html || html.length < 500 || html.includes('"redirect"')) {
                log('[quest-rewards] ERRO: HTML inválido ou redirect', 'error');
                log('[quest-rewards] Conteúdo: ' + (html ? html.substring(0, 300) : 'vazio'), 'error');
                log('[quest-rewards] O jogo redirecionou porque a requisição não veio de uma sessão válida', 'warning');
                HUD.set('build_general', 'idle', 'Erro: HTML inválido');
                return { claimed: 0 };
            }

            // Extrair hash de segurança do HTML COMPLETO
            var hashMatch = html.match(/name="h"\s+value="([a-f0-9]+)"/i);
            var securityHash = hashMatch ? hashMatch[1] : csrf;
            log('[quest-rewards] Hash de segurança extraído: ' + securityHash, 'info');

            // PASSO 2: Fazer request AJAX específico para aba de rewards
            log('[quest-rewards] Solicitando aba de rewards via AJAX...', 'info');
            return new Promise(function(resolveInner) {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: rewardTabUrl,
                    headers: {
                        'X-Requested-With': 'XMLHttpRequest',
                        'Cookie': cookies
                    },
                    withCredentials: true,
                    onload: function(resAjax) {
                        log('[quest-rewards] AJAX rewards response:', 'info');
                        log('  - status: ' + resAjax.status, 'info');
                        log('  - length: ' + (resAjax.responseText ? resAjax.responseText.length : 0) + ' chars', 'info');
                        if (resAjax.responseText && resAjax.responseText.length > 50) {
                            log('[quest-rewards] AJAX preview: ' + resAjax.responseText.substring(0, 300).replace(/\s+/g, ' '), 'info');
                        }
                        resolveInner(resAjax.responseText || '');
                    },
                    onerror: function(e) {
                        log('[quest-rewards] AJAX error: ' + JSON.stringify(e), 'error');
                        resolveInner('');
                    }
                });
            }).then(function(htmlRewards) {
                // Extrair reward_ids do AJAX da aba de rewards
                var rewardIds = [];
                var addId = function(v) {
                    if (v && !rewardIds.includes(String(v))) rewardIds.push(String(v));
                };

                // Pattern 1: data-reward-id="12345" (mais comum em AJAX moderno)
                var dataMatches = htmlRewards.match(/data-reward-id=["']?(\d+)["']?/gi) || [];
                dataMatches.forEach(function(m) {
                    var id = m.match(/\d+/);
                    if (id) addId(id[0]);
                });

                // Pattern 2: onclick="...claimReward(12345)..."
                var onclickMatches = htmlRewards.match(/onclick=["'][^"']*claimReward\(\s*(\d+)/gi) || [];
                onclickMatches.forEach(function(m) {
                    var id = m.match(/\d+/);
                    if (id) addId(id[0]);
                });

                // Pattern 3: reward_id=12345 ou reward_id:12345
                var inlineMatches = htmlRewards.match(/reward_id["']?\s*[:=]\s*["']?(\d+)/gi) || [];
                inlineMatches.forEach(function(m) {
                    var id = m.match(/\d+/);
                    if (id) addId(id[0]);
                });

                // Se não encontrou no AJAX, tentar fallback no HTML completo
                if (rewardIds.length === 0) {
                    log('[quest-rewards] Nenhum reward no AJAX, tentando fallback no HTML completo...', 'warning');

                    var dataMatchesFull = html.match(/data-reward-id=["']?(\d+)["']?/gi) || [];
                    dataMatchesFull.forEach(function(m) {
                        var id = m.match(/\d+/);
                        if (id) addId(id[0]);
                    });

                    var onclickMatchesFull = html.match(/onclick=["'][^"']*claimReward\(\s*(\d+)/gi) || [];
                    onclickMatchesFull.forEach(function(m) {
                        var id = m.match(/\d+/);
                        if (id) addId(id[0]);
                    });
                }

                log('[quest-rewards] ' + rewardIds.length + ' reward_id(s) encontrados: [' + rewardIds.join(', ') + ']', 'info');

                if (rewardIds.length === 0) {
                    log('[quest-rewards] Nenhum reward_id encontrado. Preview AJAX:', 'warning');
                    log(htmlRewards.substring(0, 500), 'info');
                    log('[quest-rewards] Preview HTML completo:', 'info');
                    log(html.substring(0, 500), 'info');
                    HUD.set('build_general', 'idle', 'Sem rewards encontrados');
                    return { claimed: 0 };
                }

                // Passo 3: POST sequencial para cada reward_id
                var claimed = 0;
                return rewardIds.reduce(function(chain, rewardId) {
                    return chain.then(function() {
                        return new Promise(function(resolve) {
                            setTimeout(function() {
                                var body = 'reward_id=' + encodeURIComponent(rewardId) + '&h=' + encodeURIComponent(securityHash);
                                GM_xmlhttpRequest({
                                    method: 'POST',
                                    url: claimUrl,
                                    headers: {
                                        'Content-Type': 'application/x-www-form-urlencoded',
                                        'X-Requested-With': 'XMLHttpRequest',
                                        'Accept': 'application/json',
                                        'Cookie': cookies
                                    },
                                    withCredentials: true,
                                    data: body,
                                    onload: function(res) {
                                        var json = null;
                                        try { json = JSON.parse(res.responseText || '{}'); } catch(e) {}

                                        log('[quest-rewards] Claim reward ' + rewardId + ':', 'info');
                                        log('  - status: ' + res.status, 'info');
                                        log('  - response: ' + (res.responseText ? res.responseText.substring(0, 100) : 'vazio'), 'info');

                                        if (res.status === 200) {
                                            if (json && json.error) {
                                                log('[quest-rewards] Erro ao coletar ' + rewardId + ': ' + json.error, 'error');
                                            } else {
                                                log('[quest-rewards] Reward ' + rewardId + ' coletado com sucesso!', 'info');
                                                claimed++;
                                            }
                                        } else {
                                            log('[quest-rewards] Erro HTTP ' + res.status + ' ao coletar ' + rewardId, 'error');
                                        }
                                        resolve();
                                    },
                                    onerror: function(e) {
                                        log('[quest-rewards] Erro ao coletar ' + rewardId + ': ' + JSON.stringify(e), 'error');
                                        resolve();
                                    }
                                });
                            }, 300); // Delay entre claims
                        });
                    });
                }, Promise.resolve()).then(function() {
                    log('[quest-rewards] Coleta concluída: ' + claimed + '/' + rewardIds.length + ' rewards coletados', 'info');
                    HUD.set('build_general', 'idle', 'Quests coletadas: ' + claimed);
                    return { claimed: claimed };
                });
            });
        });
    }

    // ============================================================
    // QUEST REWARDS - COLETA EM SEGUNDO PLANO
    // Confirmado pelo espião: GET quest_popup → JSON {response:{dialog:HTML}}
    //                         POST claim_reward com reward_id=<id>&h=<csrf>
    // ============================================================

    // Requisição AJAX para o sistema de quests.
    // Usa unsafeWindow.fetch (contexto da página, envia cookies de sessão via credentials:'include').
    // Fallback para GM_xmlhttpRequest com Referer explícito se fetch falhar.
    function questRequest(method, path, body) {
        var origin = window.location.origin;
        var referer = origin + '/game.php?village=' + getCurrentVillageId() + '&screen=overview';
        var url = origin + path;
        var headers = {
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'application/json, text/javascript, */*; q=0.01'
        };
        if (method === 'POST' && body) {
            headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
        }

        // Tenta primeiro com unsafeWindow.fetch (mesma sessão da página)
        var win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
        if (win && typeof win.fetch === 'function') {
            var opts = { method: method, credentials: 'include', headers: headers };
            if (body) opts.body = body;
            return win.fetch(url, opts).then(function(r) { return r.text(); }).catch(function(err) {
                log('[quest-req] fetch falhou (' + err.message + '), tentando GM_xmlhttpRequest...', 'warning');
                return questRequestGM(method, url, body, headers, referer);
            });
        }

        // Fallback direto para GM_xmlhttpRequest com Referer
        return questRequestGM(method, url, body, headers, referer);
    }

    function questRequestGM(method, url, body, headers, referer) {
        return new Promise(function(resolve, reject) {
            var gmHeaders = Object.assign({}, headers, { 'Referer': referer });
            GM_xmlhttpRequest({
                method: method,
                url: url,
                headers: gmHeaders,
                data: body || undefined,
                onload: function(r) { resolve(r.responseText); },
                onerror: function(e) { reject(new Error('GM_xmlhttpRequest falhou: ' + JSON.stringify(e))); }
            });
        });
    }

    async function autoCollectQuestRewards() {
        var villageId = getCurrentVillageId();
        if (!villageId) return;

        log('[quest-rewards] Iniciando verificação em segundo plano...', 'info');
        HUD.set('quest', 'running', 'Verificando...');

        // GET confirmado pelo espião: retorna {response:{dialog:"<html>..."}, game_data:{...}}
        var popupPath = '/game.php?village=' + villageId + '&screen=new_quests&ajax=quest_popup&tab=main-tab&quest=0';

        try {
            var responseText = await questRequest('GET', popupPath, null);

            var data;
            try {
                data = JSON.parse(responseText);
            } catch (e) {
                log('[quest-rewards] Resposta não é JSON válido: ' + (responseText || '').slice(0, 100), 'error');
                HUD.set('quest', 'error', 'Erro de parse');
                return;
            }

            if (data.redirect) {
                // Redirect = sem quests pendentes ou sessão não reconhecida
                log('[quest-rewards] Sem quests pendentes (redirect: ' + data.redirect + ')', 'info');
                HUD.set('quest', 'skip', 'Sem quest');
                return;
            }

            // Extrai o HTML do dialog (confirmado pelo espião: data.response.dialog)
            var dialogHTML = (data.response && data.response.dialog) ? data.response.dialog : '';
            if (!dialogHTML) {
                log('[quest-rewards] Nenhuma recompensa de quest disponível.', 'info');
                HUD.set('quest', 'skip', 'Nenhuma quest');
                return;
            }

            // Parse do HTML para extrair reward_id(s)
            var doc = new DOMParser().parseFromString(dialogHTML, 'text/html');
            var rewardIds = [];

            // Método A: data-reward-id
            doc.querySelectorAll('[data-reward-id]').forEach(function(el) {
                var id = el.getAttribute('data-reward-id');
                if (id && rewardIds.indexOf(id) === -1) rewardIds.push(id);
            });
            // Método B: input hidden
            if (rewardIds.length === 0) {
                doc.querySelectorAll('input[name="reward_id"]').forEach(function(el) {
                    if (el.value && rewardIds.indexOf(el.value) === -1) rewardIds.push(el.value);
                });
            }
            // Método C: regex no HTML bruto
            if (rewardIds.length === 0) {
                var rx = /reward_id=(\d+)/g, m;
                while ((m = rx.exec(dialogHTML)) !== null) {
                    if (rewardIds.indexOf(m[1]) === -1) rewardIds.push(m[1]);
                }
            }

            if (rewardIds.length === 0) {
                log('[quest-rewards] Modal abriu mas sem reward_id para coletar.', 'info');
                HUD.set('quest', 'skip', 'Sem coleta');
                return;
            }

            log('[quest-rewards] Encontradas ' + rewardIds.length + ' recompensa(s): [' + rewardIds.join(', ') + ']', 'success');

            // POST confirmado pelo espião: reward_id=<id>&h=<csrf>
            var csrfToken = (typeof game_data !== 'undefined' && game_data.csrf) ? game_data.csrf : '';
            var claimPath = '/game.php?village=' + villageId + '&screen=new_quests&ajax=claim_reward';

            for (var i = 0; i < rewardIds.length; i++) {
                var rId = rewardIds[i];
                log('[quest-rewards] Coletando reward_id: ' + rId + '...', 'info');
                var body = 'reward_id=' + rId + '&h=' + csrfToken;

                try {
                    var claimText = await questRequest('POST', claimPath, body);
                    var claimData = JSON.parse(claimText);

                    if (claimData.response) {
                        log('[quest-rewards] Recompensa ' + rId + ' coletada com sucesso!', 'success');
                        var ql = (typeof unsafeWindow !== 'undefined' && unsafeWindow.Questlines) || (typeof Questlines !== 'undefined' ? Questlines : null);
                        if (ql && typeof ql.update === 'function') { try { ql.update(); } catch(e) {} }
                    } else {
                        log('[quest-rewards] Falha ao coletar ' + rId + ': ' + JSON.stringify(claimData), 'warning');
                    }
                } catch (claimError) {
                    log('[quest-rewards] Erro de rede ao coletar ' + rId + ': ' + claimError.message, 'error');
                }

                // Delay entre claims (evita ban/rate-limit)
                await new Promise(function(res) { setTimeout(res, 1200 + Math.floor(Math.random() * 800)); });
            }

            HUD.set('quest', 'done', 'Coletado!');
            log('[quest-rewards] Rotina finalizada.', 'info');

        } catch (error) {
            log('[quest-rewards] Erro geral: ' + error.message, 'error');
            HUD.set('quest', 'error', 'Erro fatal');
        }
    }

    // ============================================================
    // CÁLCULO DE CONFIANÇA — modo observação
    // task: objeto de tarefa anotado pelo motor
    // state: estado da aldeia (para executabilidade e custo calibrado)
    // Retorna { score: 0-99, razao: string }
    // ============================================================
    function calcularConfianca(task, state) {
        if (!task) return { score: 100, razao: 'Aldeia estável — sem ações pendentes' };

        if (task.id === 'build_rush' || task.id === 'knight_rush') {
            return { score: 98, razao: 'Rush confirmado: obra já em fila, custo zero' };
        }
        if (task.id === 'claim_quest_rewards') {
            return { score: 82, razao: 'Recompensas de quest disponíveis — baixo risco' };
        }
        if (task.id === 'flag') {
            return { score: 88, razao: 'Bandeira não atribuída — ação de baixo risco' };
        }
        if (task.id === 'statue' || task.id === 'knight') {
            return { score: 85, razao: 'Recrutamento disponível e confirmado pelo DOM' };
        }
        if (task.id === 'build_general') {
            var tierBase = { P0: 95, P_NOBLING: 93, P1B: 92, P1C: 90, P2: 85, P3: 75, P3_5: 80, P4: 68 };
            var conf = tierBase[task.tier] || 68;
            var parts = [];

            // Tier label legível
            var tierLabels = {
                P0: 'Pop emergência (95%+)',
                P_NOBLING: 'Nobling prep',
                P1B: 'Armazém crítico (<1.5h)',
                P1C: 'Pop prioridade (92-95%)',
                P2: 'Anti-overflow rápido',
                P3: 'Marco estratégico',
                P3_5: 'Farm preventivo (88-92%)',
                P4: 'Otimização por score'
            };
            parts.push(tierLabels[task.tier] || 'Score geral');

            // Margem sobre o 2º colocado (aplica apenas para P3/P4 onde há competição)
            if ((task.tier === 'P3' || task.tier === 'P4') && task.scoreMargin > 0) {
                var marginBonus = Math.min(15, Math.floor(task.scoreMargin / 5));
                conf += marginBonus;
                if (marginBonus >= 5) parts.push('margem clara (+' + task.scoreMargin.toFixed(1) + ')');
            }

            // Executabilidade confirmada pelo DOM
            if (state.buildCandidatesDOM && state.buildCandidatesDOM.indexOf(task.target) !== -1) {
                conf += 4;
                parts.push('DOM confirma');
            }

            // Confiança na calibração de custo
            try {
                var _ctxKey = getCostContextKey(state.villageId || '');
                var _confData = JSON.parse(GM_getValue('twbot_cost_confidence_' + _ctxKey, '{}') || '{}');
                var _cScore = (_confData[task.target] || {}).score || 0;
                if (_cScore >= 60) { conf += 3; }
                else if (_cScore < 20) { conf -= 8; parts.push('custo estimado (dados escassos)'); }
            } catch(e) {}

            return { score: Math.max(10, Math.min(99, conf)), razao: parts.join(' | ') };
        }
        return { score: 75, razao: 'Ação de suporte' };
    }

    // ============================================================
    // TIMING SYNC — agenda próximo ciclo baseado no término real da fila,
    // não em intervalo fixo. Garante que o bot chegue exatamente quando
    // uma obra termina, capturando a janela de free rush perfeitamente.
    // ============================================================
    function calcNextRunDelay() {
        var freeWindowSecs = CONFIG.freeRushMinutes * 60; // ex: 180s
        var minSecsLeft = Infinity;

        // Lê timers ao vivo do DOM (o jogo atualiza a cada segundo)
        var liveEls = document.querySelectorAll(
            '#build_queue tr .timer, #build_queue .timer, ' +
            '.lit-item .timer, .buildqueue_container .timer, ' +
            'tr[id^="order_"] .timer'
        );
        liveEls.forEach(function(el) {
            var s = timeToSeconds(el.textContent.trim());
            if (s > 0 && s < minSecsLeft) minSecsLeft = s;
        });

        if (minSecsLeft !== Infinity && minSecsLeft > 0) {
            // Chega 2s após o término da obra para capturar free rush
            var targetMs = minSecsLeft * 1000 + 2000;
            var minMs    = 5000;
            var maxMs    = CONFIG.mainLoopInterval;
            var delay    = Math.max(minMs, Math.min(maxMs, targetMs));
            var tag = minSecsLeft <= freeWindowSecs ? '⚡ free rush' : 'sync fila';
            log('[timing] Fila termina em ' + minSecsLeft + 's → próximo ciclo em ' +
                Math.round(delay / 1000) + 's (' + tag + ')', 'info');
            return delay;
        }

        // Fila vazia: intervalo padrão com jitter anti-sincronização
        return CONFIG.mainLoopInterval + Math.floor(Math.random() * 4000) - 2000;
    }

    function runChecklist(villageId) {
        villageId = normalizeVillageId(villageId);
        if (!villageId) { log('[runChecklist] villageId inválido, abortando', 'error'); return; }
        HUD.init();

        // Aplicar soft reset se necessário
        VillageMemory.softReset(villageId);

        // Verificar se aldeia pode executar ações (actionLock + cooldown)
        if (!VillageMemory.canAct(villageId)) {
            log('[runChecklist] Aldeia ' + villageId + ' em cooldown ou bloqueada, aguardando...', 'warning');
            setTimeout(() => runChecklist(villageId), calcNextRunDelay());
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

                // ── MODO OBSERVAÇÃO: analisa, exibe, não executa ──
                if (CONFIG.observationMode) {
                    VillageMemory.releaseLock(villageId);
                    var _obsTask = queue.find(function(t) {
                        return t.id === 'build_general' || t.id === 'build_rush' || t.id === 'knight_rush' || t.id === 'flag' || t.id === 'statue' || t.id === 'knight';
                    });
                    var _conf = calcularConfianca(_obsTask, state);
                    var _alvoNivel = (_obsTask && _obsTask.target && state.niveis)
                        ? (parseInt(state.niveis[_obsTask.target] || 0) + 1) : null;
                    var _altNivel = (_obsTask && _obsTask.alternative && _obsTask.alternative.ed && state.niveis)
                        ? (parseInt(state.niveis[_obsTask.alternative.ed] || 0) + 1) : null;
                    HUD.showObsReport({
                        alvo:        _obsTask ? (_obsTask.target || _obsTask.id) : 'Nenhuma',
                        nivel:       _alvoNivel,
                        confianca:   _conf.score,
                        razao:       _conf.razao,
                        alternativa: _obsTask && _obsTask.alternative ? _obsTask.alternative.ed : null,
                        altNivel:    _altNivel
                    });
                    log('[obs] Análise: ' + (_obsTask ? _obsTask.target || _obsTask.id : 'nada') + ' — confiança ' + _conf.score + '% (' + _conf.razao + ')', 'info');
                    setTimeout(() => runChecklist(villageId), calcNextRunDelay());
                    return;
                }

                function execNext(i) {
                    if (i >= queue.length) {
                        // Liberar lock ao finalizar todas as tarefas
                        VillageMemory.releaseLock(villageId);
                        var wait = queue.length > 0 ? 5000 : calcNextRunDelay();
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
                        if (VillageMemory.isTargetBlocked(villageId, task.target)) {
                            log('[executor] Target ' + task.target + ' está bloqueado, pulando', 'warning');
                            p = Promise.resolve(false);
                        } else {
                            var _learnBuilding = task.target;
                            var _learnLevel    = task.levelBuilt || 1;
                            var _learnRoi      = task.roiExpected || 0.001;
                            var _learnProd0    = (state.producao.wood || 0) + (state.producao.stone || 0) + (state.producao.iron || 0);
                            p = executeBuildPlan({ villageId: villageId, building: _learnBuilding })
                                .then(function(result) {
                                    if (result && result.ok) {
                                        LearningEngine.recordBuild(villageId, _learnBuilding, _learnLevel, _learnRoi, _learnProd0);
                                    }
                                    return result && result.ok;
                                });
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
                        p = bgAssignFlagGhost(villageId, state.phase, task.ctx)
                            .then(function(res) {
                                if (res && res.ok) {
                                    VillageMemory.recordSuccess(villageId, 'flag');
                                } else {
                                    VillageMemory.recordError(villageId, 'flag', 'flag_fail');
                                }
                                return res;
                            });
                    }
                    else if (task.id === 'claim_quest_rewards') {
                        // Usa a nova função baseada no interceptador (mais limpa e direta)
                        // autoCollectQuestRewards agora é async e não precisa de parâmetros
                        p = autoCollectQuestRewards()
                            .then(function(result) {
                                if (result !== undefined && result !== null) {
                                    VillageMemory.recordSuccess(villageId, 'quest_rewards');
                                    log('[motorDeDecisao] Recursos de quest injetados! Reavaliando no próximo ciclo...', 'success');
                                } else {
                                    log('[motorDeDecisao] Sem recompensas de quest disponíveis no momento.', 'info');
                                }
                                return result;
                            });
                    }
                    else if (task.id === 'unlock_scavenge') {
                        p = checkAndUnlockScavenge(villageId)
                            .then(function(success) {
                                if (success) {
                                    VillageMemory.recordSuccess(villageId, 'unlock_scavenge');
                                    log('[motorDeDecisao] Coleta desbloqueada com sucesso!', 'success');
                                } else {
                                    VillageMemory.recordError(villageId, 'unlock_scavenge', 'scavenge_fail');
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
        }).catch(function(err) {
            VillageMemory.releaseLock(villageId);
            log('[runChecklist] Falha crítica: ' + (err && err.message || err), 'error');
            setTimeout(function() { runChecklist(villageId); }, calcNextRunDelay());
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

    // ============================================================
    // SELEÇÃO DE BANDEIRA - APENAS REGRA LOCAL (SEM IA)
    // Decisão baseada em thresholds e score auditável
    // ============================================================
    function selectBestFlagLocal(flags, phase) {
        if (!flags || !flags.length) return null;

        // Pesos por categoria e fase do jogo
        var weights = {
            EARLY:  { resource: 100, population: 80, recruitment: 60, attack: 50, defense: 40, loot: 30, luck: 20, coin: 10 },
            MID:    { attack: 100, loot: 90, recruitment: 80, resource: 70, population: 60, defense: 50, luck: 40, coin: 30 },
            LATE:   { attack: 100, loot: 95, coin: 80, recruitment: 70, resource: 60, population: 50, defense: 40, luck: 30 }
        };

        var w = weights[phase] || weights.EARLY;

        // Calcular score para cada bandeira
        var scored = flags.map(function(f) {
            var baseScore = w[f.category] || 0;
            var levelBonus = f.level * 3;
            var quantityBonus = (f.count || 0) > 1 ? 10 : 0;
            return {
                flag: f,
                score: baseScore + levelBonus + quantityBonus
            };
        });

        // Ordenar por score e retornar a melhor
        scored.sort(function(a, b) { return b.score - a.score; });

        log('[bandeira] Selecionada: ' + scored[0].flag.name + ' (score: ' + scored[0].score + ')', 'info');
        return scored[0].flag;
    }

    function runFlagsMode() {
        log('Modo: Tela de Bandeiras (DOM)');
        var flags = extractAvailableFlags();
        if (!flags.length) { log('Nenhuma bandeira disponivel.', 'warning'); return; }
        var points = getVillagePoints();
        var phase = getGamePhase(points);
        var alreadyAssigned = isCurrentFlagAssigned();
        if (alreadyAssigned) { log('Bandeira ja atribuida.'); return; }

        // Seleção 100% local, sem IA
        var best = selectBestFlagLocal(flags, phase);
        if (!best) return;
        highlightBestFlag(best.element);
        if (CONFIG.autoAssignFlag) {
            HUD.set('flag', 'running', 'DOM: ' + best.name + ' Nv.' + best.level);
            setTimeout(function () { assignFlag(best.element); }, 1500);
        }
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
    // SISTEMA DE GERENCIAMENTO MULTI-VILLAGE
    // ============================================================
    var VillageManager = {
        villages: [],
        currentVillageIndex: 0,
        lastCheckAll: 0,

        // Obter todas as aldeias do jogador
        getAllVillages: function() {
            try {
                if (typeof game_data === 'undefined' || !game_data.player) {
                    return [];
                }

                var villages = [];
                for (var id in game_data.player.villages) {
                    var v = game_data.player.villages[id];
                    villages.push({
                        id: String(v.id),
                        name: v.name,
                        x: v.x,
                        y: v.y,
                        points: parseInt(v.points) || 0,
                        isMain: v.is_main || false
                    });
                }
                return villages;
            } catch (e) {
                log('[VillageManager] Erro ao obter aldeias: ' + e.message, 'error');
                return [];
            }
        },

        // Calcular score de urgência para uma aldeia
        calculateUrgencyScore: function(villageId, state) {
            if (!state) return 50;

            var mem = VillageMemory.get(villageId);
            var _premium = state.premium || {};
            var _rushIds = state.rushIds || [];
            var _knight  = state.knight  || {};
            var _pop = state.populacao || { current: 0, max: 1 };
            var _res = state.recursos  || { wood: 0, stone: 0, iron: 0, max: 1 };

            var bonus   = 0; // acumulado de fatores positivos
            var penalty = 0; // acumulado de fatores negativos

            // 1. População crítica — contribui até 40 pontos de bônus
            var popRatio = _pop.current / (_pop.max || 1);
            if      (popRatio > 0.95) bonus += 40;
            else if (popRatio > 0.90) bonus += 30;
            else if (popRatio > 0.85) bonus += 20;
            else if (popRatio > 0.80) bonus += 10;

            // 2. Armazém cheio — contribui até 35 pontos de bônus
            var resMax = _res.max || 1;
            var resRatio = Math.max(
                _res.wood  / resMax,
                _res.stone / resMax,
                _res.iron  / resMax
            );
            if      (resRatio > 0.95) bonus += 35;
            else if (resRatio > 0.90) bonus += 25;
            else if (resRatio > 0.85) bonus += 15;

            // 3. Fila de construção — contribui até 15 pontos de bônus
            if      (state.filaBuilds === 0 && _premium.ativo) bonus += 15;
            else if (state.filaBuilds < 2)                     bonus += 10;

            // 4. Rush disponível — contribui até 35 pontos de bônus
            if (_rushIds.length > 0) bonus += 20;
            if (state.knightRushId)  bonus += 15;

            // 5. Bandeira não atribuída — contribui 10 pontos de bônus
            if (!state.flagAssigned) bonus += 10;

            // 6. Paladino pronto para recrutar — contribui 15 pontos de bônus
            if (_knight.canRecruit && !_knight.isRecruiting) bonus += 15;

            // 7. Perfil econômico com recursos baixos — contribui 15 pontos de bônus
            if (mem.profile === VillageMemory.PROFILES.ECONOMIC && resRatio < 0.5) bonus += 15;

            // 8. Perfil militar com fila vazia — contribui 10 pontos de bônus
            if (mem.profile === VillageMemory.PROFILES.MILITARY && state.filaBuilds === 0) bonus += 10;

            // 9. Em cooldown — 30 pontos de penalidade
            if (mem.cooldownUntil && Date.now() < mem.cooldownUntil) penalty += 30;

            // 10. Muitas falhas consecutivas — até 20 pontos de penalidade
            if      (mem.consecutiveFails >= 3) penalty += 20;
            else if (mem.consecutiveFails >= 2) penalty += 10;

            // 11. Ação em progresso — 25 pontos de penalidade
            if (mem.actionLock && Date.now() < mem.actionLock) penalty += 25;

            // 12. Bônus de cluster: papel desta aldeia na estratégia da frota
            var clusterBonus = VillageCoordinator.getClusterUrgencyBonus(villageId, VillageManager.villages);
            bonus += clusterBonus;

            // Normalização: mapeia bônus [0..195] → [0..50] e penalidade [0..75] → [0..50]
            var MAX_BONUS   = 195; // 175 base + 20 cluster máximo
            var MAX_PENALTY =  75; // 30+20+25
            var score = 50
                + Math.round((bonus   / MAX_BONUS)   * 50)
                - Math.round((penalty / MAX_PENALTY) * 50);

            return Math.max(0, Math.min(100, score));
        },

        // Classificar aldeias por urgência
        rankVillages: function() {
            var self = this;
            var ranked = [];

            this.villages.forEach(function(v) {
                // Tentar obter estado salvo ou calcular score básico
                var mem = VillageMemory.get(v.id);
                var rawState = GM_getValue('village_last_state_' + v.id, null);
                var lastState = null;
                if (rawState) {
                    try { lastState = typeof rawState === 'string' ? JSON.parse(rawState) : rawState; } catch(e) {}
                }
                var score = self.calculateUrgencyScore(v.id, lastState);

                ranked.push({
                    village: v,
                    score: score,
                    profile: mem.profile,
                    lastSuccess: mem.lastSuccess,
                    inCooldown: mem.cooldownUntil && Date.now() < mem.cooldownUntil,
                    actionLock: mem.actionLock
                });
            });

            // Ordenar por score (maior urgência primeiro)
            ranked.sort(function(a, b) { return b.score - a.score; });

            return ranked;
        },

        // Obter próxima aldeia para processamento
        getNextVillage: function() {
            var ranked = this.rankVillages();
            if (ranked.length === 0) return null;

            // Retorna a aldeia com maior urgência
            return ranked[0].village;
        },

        // Atualizar lista de aldeias
        refreshVillages: function() {
            this.villages = this.getAllVillages();
            log('[VillageManager] ' + this.villages.length + ' aldeias encontradas', 'info');

            // Inicializar ou re-detectar perfil para aldeias (re-detecta a cada 2h mesmo se não BALANCED,
            // pois a aldeia pode ter mudado de foco desde a última classificação)
            var self = this;
            var REDETECT_INTERVAL_MS = 7200000; // 2 horas
            this.villages.forEach(function(v) {
                var mem = VillageMemory.get(v.id);
                var lastDetectionTs = GM_getValue('village_profile_ts_' + v.id, 0);
                // Perfis manuais nunca são sobrescritos pela auto-detecção
                var manualProfiles = [
                    VillageMemory.PROFILES.SPEED_START,
                    VillageMemory.PROFILES.FAKE_FARM,
                    VillageMemory.PROFILES.HARD_MILITARY_RUSH
                ];
                var needsDetection  = !mem.profile
                    || (manualProfiles.indexOf(mem.profile) === -1 && (
                        mem.profile === VillageMemory.PROFILES.BALANCED
                        || (Date.now() - lastDetectionTs) > REDETECT_INTERVAL_MS
                    ));

                if (needsDetection) {
                    var rawSavedState = GM_getValue('village_last_state_' + v.id, null);
                    var savedState = null;
                    if (rawSavedState) {
                        try { savedState = typeof rawSavedState === 'string' ? JSON.parse(rawSavedState) : rawSavedState; } catch (e) {}
                    }
                    var detectedProfile = self.autoDetectProfile(savedState);
                    if (detectedProfile !== mem.profile) {
                        log('[VillageManager] Perfil de ' + v.id + ' atualizado: ' + mem.profile + ' → ' + detectedProfile, 'info');
                        VillageMemory.setProfile(v.id, detectedProfile);
                    }
                    GM_setValue('village_profile_ts_' + v.id, Date.now());
                }
            });

            // Coordenação inter-aldeias: garante diversidade de roles na frota
            VillageCoordinator.coordinateRoles(this.villages);

            return this.villages;
        },

        // Auto-detectar perfil da aldeia a partir do estado salvo completo.
        // Aceita o objeto state (com niveis, recursos, populacao, phase) — NÃO os níveis isolados.
        autoDetectProfile: function(state) {
            if (!state || !state.niveis) return VillageMemory.PROFILES.BALANCED;

            var lvl   = state.niveis;
            var phase = state.phase || 'EARLY';
            var _res  = state.recursos  || { wood: 0, stone: 0, iron: 0, max: 1 };
            var _pop  = state.populacao || { current: 0, max: 1 };

            // ==========================================
            // [LC RUSH] - Detecção automática para LC Rush
            // ==========================================
            // Se Quartel >= 3 E Estábulo desbloqueado OU em progresso → LC_RUSH
            var barracksLevel = parseInt(lvl.barracks) || 0;
            var stableLevel = parseInt(lvl.stable) || 0;
            var smithLevel = parseInt(lvl.smith) || 0;
            var mainLevel = parseInt(lvl.main) || 0;
            
            // Sinais de LC Rush: foco em quartel + estábulo + ferreiro, minas congeladas no 10
            var isLCRushSignal = false;
            
            // Estado 1: Base (0-500 pts) - Quartel inicial
            if (barracksLevel >= 1 && mainLevel >= 5 && phase === 'EARLY') {
                isLCRushSignal = true;
                log('[autoDetectProfile] Sinal LC Rush detectado: Quartel desbloqueado cedo', 'info');
            }
            
            // Estado 2: Preparação (500-1500 pts) - Quartel 5 + minas no 10
            if (barracksLevel >= 5 && mainLevel >= 10) {
                var minesFrozen = (parseInt(lvl.wood) || 0) >= 10 && 
                                  (parseInt(lvl.stone) || 0) >= 10 && 
                                  (parseInt(lvl.iron) || 0) >= 10;
                if (minesFrozen) {
                    isLCRushSignal = true;
                    log('[autoDetectProfile] Sinal LC Rush detectado: Minas congeladas no 10 + Quartel 5', 'info');
                }
            }
            
            // Estado 3: Gate Militar (1500-2500 pts) - Estábulo 3 + Ferreiro 5
            if (stableLevel >= 1 && smithLevel >= 3) {
                isLCRushSignal = true;
                log('[autoDetectProfile] Sinal LC Rush detectado: Estábulo + Ferreiro em progresso', 'info');
            }
            
            // Estado 4: Pós-LC (2500+ pts) - Estábulo evoluído
            if (stableLevel >= 3) {
                isLCRushSignal = true;
                log('[autoDetectProfile] Sinal LC Rush detectado: Estábulo >= 3 (LC desbloqueado)', 'success');
            }
            
            if (isLCRushSignal) {
                log('[autoDetectProfile] 🎯 PERFIL LC_RUSH DETECTADO - Caminho crítico ativado!', 'success');
                return 'lc_rush';
            }
            // ==========================================

            // Pontuação base pela composição de edifícios
            var militaryScore = (parseInt(lvl.barracks) || 0)
                + (parseInt(lvl.stable) || 0) * 1.2
                + (parseInt(lvl.smith)  || 0);
            var economicScore = (parseInt(lvl.wood)    || 0)
                + (parseInt(lvl.stone)   || 0)
                + (parseInt(lvl.iron)    || 0) * 1.1
                + (parseInt(lvl.storage) || 0);
            var defenseScore  = (parseInt(lvl.wall)   || 0)
                + (parseInt(lvl.hide)    || 0)
                + (parseInt(lvl.church)  || 0);

            // Fator 1 — Nível do HQ: HQ alto acelera todas as obras → tendência BALANCED
            var hqLevel = parseInt(lvl.main) || 0;
            var hqBonus = HQ_PRODUCTIVITY_BONUS[Math.min(hqLevel, 25)] || 0;
            if (hqLevel >= 10) {
                economicScore *= (1 + hqBonus * 0.3);
                militaryScore *= (1 + hqBonus * 0.3);
            }

            // Fator 2 — Pressão de armazém: recursos constantemente cheios → econômico
            var resMax   = _res.max || 1;
            var resRatio = Math.max(_res.wood / resMax, _res.stone / resMax, _res.iron / resMax);
            if (resRatio > 0.9) economicScore *= 1.2;

            // Fator 3 — Fase: amplificadores de score E thresholds de decisão específicos por fase.
            // EARLY usa thresholds reduzidos para classificar mais cedo e evitar ficar em BALANCED
            // desnecessariamente enquanto a aldeia já demonstra especialização clara.
            var threshMilitary, threshEconomic, threshDefense;
            if (phase === 'EARLY') {
                economicScore  *= 1.4; // Forte viés econômico em EARLY (era 1.2)
                militaryScore  *= 1.1; // Amplifica sinais militares incipientes
                // Sinal de especialização precoce: barracks/smith já evoluídos indicam MILITARY
                var earlyMilSignal = (parseInt(lvl.barracks) || 0) >= 3 || (parseInt(lvl.smith) || 0) >= 2;
                if (earlyMilSignal) militaryScore *= 1.2;
                // Thresholds reduzidos → decisão mais agressiva na fase inicial
                threshMilitary = 1.1;  // era 1.3
                threshEconomic = 1.2;  // era 1.5
                threshDefense  = 1.05; // era 1.2 / 1.1
            } else if (phase === 'MID') {
                militaryScore  *= 1.1;
                threshMilitary = 1.2;
                threshEconomic = 1.35;
                threshDefense  = 1.15;
            } else { // LATE — mantém comportamento conservador original
                militaryScore  *= 1.3;
                threshMilitary = 1.3;
                threshEconomic = 1.5;
                threshDefense  = 1.2;
            }

            log('[autoDetectProfile] phase=' + phase + ' mil=' + militaryScore.toFixed(1) + ' eco=' + economicScore.toFixed(1) + ' def=' + defenseScore.toFixed(1) + ' threshMil=' + threshMilitary + ' threshEco=' + threshEconomic, 'debug');

            // Decisão com thresholds calibrados por fase
            if (militaryScore > economicScore * threshMilitary && militaryScore > defenseScore * threshDefense) {
                return VillageMemory.PROFILES.MILITARY;
            } else if (economicScore > militaryScore * threshEconomic && economicScore > defenseScore * threshDefense) {
                return VillageMemory.PROFILES.ECONOMIC;
            } else if (defenseScore > militaryScore * threshDefense && defenseScore > economicScore * (threshDefense * 0.9)) {
                return VillageMemory.PROFILES.SUPPORT;
            }

            return VillageMemory.PROFILES.BALANCED;
        },

        // Salvar estado da aldeia para ranking futuro (apenas campos serializáveis e compactos)
        saveVillageState: function(villageId, state) {
            if (!state) return;
            var compact = {
                populacao:    state.populacao,
                recursos:     state.recursos,
                niveis:       state.niveis,
                filaBuilds:   state.filaBuilds,
                rushIds:      state.rushIds,
                knightRushId: state.knightRushId,
                premium:      state.premium,
                phase:        state.phase,
                flagAssigned: state.flagAssigned,
                canBuildStatue: state.canBuildStatue,
                knight: state.knight ? {
                    canRecruit:   state.knight.canRecruit,
                    isPresent:    state.knight.isPresent,
                    isRecruiting: state.knight.isRecruiting,
                    statueExists: state.knight.statueExists
                } : null
            };
            GM_setValue('village_last_state_' + villageId, JSON.stringify(compact));
        },

        // Mostrar status do gerenciamento multi-village
        getStatus: function() {
            var ranked = this.rankVillages();
            var status = ranked.map(function(r, i) {
                return (i+1) + '. ' + r.village.name + ' (score: ' + r.score + ', perfil: ' + r.profile + ')';
            });
            return status.join('\n');
        }
    };

    // ============================================================
    // VILLAGE COORDINATOR — coordenação de roles entre aldeias da frota
    // Garante diversidade estratégica: eco + mil + suporte ao invés de
    // todas as aldeias fazendo a mesma coisa.
    // ============================================================
    var VillageCoordinator = {
        COORD_KEY:  'twbot_coord_ts_',   // ts da última coordenação por aldeia
        COORD_INTERVAL_MS: 14400000,     // re-coordena a cada 4h
        MANUAL_PROFILES: ['speed_start', 'fake_farm', 'hard_military_rush', 'lc_rush'],
        ROLE_PLAN: ['economic', 'military', 'support', 'balanced'], // por ordem de desenvolvimento

        // Distribui roles complementares pela frota.
        // Regra central: garante que não hajam 2+ aldeias com o mesmo role automático.
        // Manual profiles (speed_start, fake_farm, hard_military_rush) nunca são tocados.
        coordinateRoles: function(villages) {
            if (!villages || villages.length < 2) return;
            var self = this;
            var now  = Date.now();

            // Separa aldeias que o coordenador pode gerenciar
            var managed = villages.filter(function(v) {
                return self.MANUAL_PROFILES.indexOf(VillageMemory.get(v.id).profile) === -1;
            });
            if (managed.length < 2) return;

            // Ordena por pontos (mais desenvolvida = role mais "nobre" no plano)
            managed.sort(function(a, b) { return (b.points || 0) - (a.points || 0); });

            // Detectar duplicação de roles
            var roleCounts = {};
            managed.forEach(function(v) {
                var p = VillageMemory.get(v.id).profile || 'balanced';
                roleCounts[p] = (roleCounts[p] || 0) + 1;
            });
            var hasDuplication = Object.values(roleCounts).some(function(c) { return c > 1; });
            var allBalanced    = managed.every(function(v) { return VillageMemory.get(v.id).profile === 'balanced'; });

            // Só redistribui se houver duplicação ou todos forem balanced
            if (!hasDuplication && !allBalanced) return;

            var changed = [];
            managed.forEach(function(v, idx) {
                var desired  = self.ROLE_PLAN[Math.min(idx, self.ROLE_PLAN.length - 1)];
                var current  = VillageMemory.get(v.id).profile;
                var lastTs   = GM_getValue(self.COORD_KEY + v.id, 0);

                if (desired !== current && (now - lastTs) > self.COORD_INTERVAL_MS) {
                    VillageMemory.setProfile(v.id, desired);
                    GM_setValue(self.COORD_KEY + v.id, now);
                    changed.push((v.name || v.id) + ': ' + current + ' → ' + desired);
                }
            });

            if (changed.length) {
                log('[cluster] Coordenação: ' + changed.join(' | '), 'success');
            }
        },

        // Bônus de urgência baseado no papel da aldeia no cluster
        // Retorna delta a ser somado ao calculateUrgencyScore
        getClusterUrgencyBonus: function(villageId, villages) {
            if (!villages || villages.length < 2) return 0;
            var myProfile     = VillageMemory.get(villageId).profile;
            var otherProfiles = villages
                .filter(function(v) { return v.id !== villageId; })
                .map(function(v) { return VillageMemory.get(v.id).profile; });

            // Única aldeia econômica: alta prioridade (as outras dependem de recursos)
            if (myProfile === 'economic') {
                var otherEco = otherProfiles.filter(function(p) { return p === 'economic'; }).length;
                if (otherEco === 0) return 20;
            }
            // Aldeia militar: sempre urgente para manter pressão ofensiva
            if (myProfile === 'military' || myProfile === 'hard_military_rush') return 10;
            // Aldeia de suporte: bônus moderado
            if (myProfile === 'support') return 5;
            return 0;
        },

        // Detecta estagnação: armazém quase cheio COM fila lotada = perda passiva de recursos
        checkStagnation: function(state) {
            if (!state || !state.recursos) return null;
            var max  = state.recursos.max || 1;
            var fill = Math.max(
                (state.recursos.wood  || 0) / max,
                (state.recursos.stone || 0) / max,
                (state.recursos.iron  || 0) / max
            );
            if (fill > 0.95 && (state.filaBuilds || 0) >= 2) return 'critical';
            if (fill > 0.85 && (state.filaBuilds || 0) >= 2) return 'warning';
            return null;
        },

        // Overview de toda a frota para o HUD
        getOverview: function(villages) {
            if (!villages || !villages.length) return [];
            var currentVid = String((typeof game_data !== 'undefined' && game_data.village)
                ? game_data.village.id : '');
            var ICON = {
                economic: '💰', military: '⚔️', support: '🛡️', balanced: '⚖️',
                speed_start: '🚀', fake_farm: '🌾', hard_military_rush: '⚔️'
            };
            return villages.map(function(v) {
                var profile = VillageMemory.get(v.id).profile || 'balanced';
                var saved   = {};
                try { var r = GM_getValue('village_last_state_' + v.id, null); if (r) saved = JSON.parse(r); } catch(e) {}
                var stag = VillageCoordinator.checkStagnation(saved);
                return {
                    id: v.id, name: v.name || v.id,
                    icon: ICON[profile] || '⚖️', profile: profile,
                    phase: saved.phase || '?', fila: saved.filaBuilds || 0,
                    points: v.points || 0,
                    stagnation: stag,
                    isCurrent: v.id === currentVid
                };
            });
        }
    };

    // ============================================================
    // INIT
    // ============================================================
    function init() {
        // Iframe do bot (knight e flag usam o mesmo name): o opener controla os cliques
        if (window.name === 'tw-bot-knight') {
            log('[init] Executando em iframe bot — skip auto actions');
            return;
        }
        log('TW Smart Automation v8.0 - Multi-Village Manager iniciado.');

        // Limpeza periódica do cache — independente do ciclo de coleta de estado
        setInterval(function() { RequestCache.cleanup(); }, CONFIG.cacheExpiryMs * 4);

        // Refresh inicial das aldeias
        VillageManager.refreshVillages();

        var villageId = normalizeVillageId(getCurrentVillageId());
        var screen = getScreenParam();

        // Background checklist roda em QUALQUER tela
        if (villageId) {
            // Salvar estado inicial para ranking
            collectVillageState(villageId).then(function(state) {
                VillageManager.saveVillageState(villageId, state);
            });

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

    window.TWBot = {
        config: CONFIG,
        hud: HUD,
        villageManager: VillageManager,
        memory: VillageMemory,
        // API para definir perfil manualmente por aldeia
        setVillageProfile: function(villageId, profile) {
            VillageMemory.setProfile(villageId, profile);
        },
        // API para obter ranking de urgência
        getUrgencyRanking: function() {
            return VillageManager.rankVillages();
        },
        // API para forçar refresh das aldeias
        refreshVillages: function() {
            return VillageManager.refreshVillages();
        },
        // Define custo de um edifício para este mundo e persiste para a próxima sessão.
        // Uso: TWBot.setCostOverride('barracks', [90, 130, 0, 130])
        setCostOverride: function(building, costsArray) {
            if (!building || !Array.isArray(costsArray) || costsArray.length < 3) {
                console.error('[TWBot] setCostOverride: espera (string, [w, s, i, t])');
                return;
            }
            TW_BUILDING_COSTS[building] = costsArray;
            try {
                var raw = GM_getValue('twbot_costs_override', null);
                var stored = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
                stored[building] = costsArray;
                GM_setValue('twbot_costs_override', JSON.stringify(stored));
                // Override manual = confiança máxima para este edifício
                var _wId    = (typeof game_data !== 'undefined' && game_data.world)
                    ? game_data.world : window.location.hostname.replace(/[^a-z0-9]/gi, '_');
                var ctxKey  = getCostContextKey(_wId);
                var confKey = 'twbot_cost_confidence_' + ctxKey;
                var conf = {}; try { conf = JSON.parse(GM_getValue(confKey, null) || '{}'); } catch(e) {}
                conf[building] = { score: 100, hits: 1, source: 'override', ts: Date.now() };
                GM_setValue(confKey, JSON.stringify(conf));
                console.log('[TWBot] Override salvo para ' + building + ': ' + JSON.stringify(costsArray) + ' (confiança: 100)');
            } catch (e) { console.error('[TWBot] Erro ao salvar override: ' + e.message); }
        },
        // Retorna os overrides manuais ativos em relação aos defaults.
        getCostOverrides: function() {
            try {
                var raw = GM_getValue('twbot_costs_override', null);
                return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
            } catch (e) { return {}; }
        },
        // Retorna confidence score por edifício para o contexto atual (mundo+mercado+idioma).
        // Scores: 0-39 = fallback estático; 40-69 = parcialmente calibrado; 70-100 = calibrado por DOM.
        getCostConfidence: function() {
            try {
                var _wId   = (typeof game_data !== 'undefined' && game_data.world)
                    ? game_data.world : window.location.hostname.replace(/[^a-z0-9]/gi, '_');
                var ctxKey = getCostContextKey(_wId);
                var raw    = GM_getValue('twbot_cost_confidence_' + ctxKey, null);
                return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
            } catch(e) { return {}; }
        },
        // Força re-scraping de custos na próxima visita a screen=main.
        // Útil após mudança de mundo, idioma ou atualização do jogo.
        clearCostCache: function() {
            try {
                var _wId   = (typeof game_data !== 'undefined' && game_data.world)
                    ? game_data.world : window.location.hostname.replace(/[^a-z0-9]/gi, '_');
                var ctxKey = getCostContextKey(_wId);
                GM_setValue('twbot_costs_scraped_' + ctxKey, 0);
                GM_setValue('twbot_force_rescrape', 1);
                console.log('[TWBot] Cache de custos limpo para contexto "' + ctxKey + '". Re-scraping na próxima visita.');
            } catch(e) { console.error('[TWBot] Erro em clearCostCache: ' + e.message); }
        }
    };

})();
