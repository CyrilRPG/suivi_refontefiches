// ============================================
// CONSTANTS
// ============================================

const STATUSES = ['EN_ATTENTE', 'EN_COURS', 'EN_RELECTURE', 'VALIDE'];
const PRIORITIES = ['BASSE', 'MOYENNE', 'HAUTE'];

// Marquer que le script a commencé
window._appJsLoading = true;
console.log('app.js: début du chargement');

// ============================================
// IMPORT EXCEL MODULE (défini en premier pour toujours être disponible)
// ============================================

const ImportXlsx = {
    normalizeText(str) {
        if (!str || typeof str !== 'string') return '';
        return str.trim().replace(/\s+/g, ' ');
    },

    generateId() {
        // Toujours générer un UUID valide pour Supabase
        if (crypto.randomUUID) {
            return crypto.randomUUID();
        }
        // Fallback: générer un UUID v4 valide
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    },

    parseExcelFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const data = new Uint8Array(e.target.result);
                    const workbook = XLSX.read(data, { type: 'array' });
                    resolve(workbook);
                } catch (error) {
                    reject(error);
                }
            };
            reader.onerror = reject;
            reader.readAsArrayBuffer(file);
        });
    },

    extractSheetsData(workbook) {
        const sheetsData = [];
        workbook.SheetNames.forEach(sheetName => {
            const sheet = workbook.Sheets[sheetName];
            const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
            const rows = [];
            let lastSubject = '';
            jsonData.forEach((row, index) => {
                let subject = this.normalizeText(row[0]);
                const item = this.normalizeText(row[1]);
                const subjLower = (subject || '').toLowerCase();
                const itemLower = (item || '').toLowerCase();
                const looksLikeHeader = subjLower.startsWith('mati') ||
                    itemLower.includes('fiches de cours actualisées') ||
                    itemLower.startsWith('fiches de cours') ||
                    (subjLower.includes('mati') && itemLower.includes('fiche'));
                if (looksLikeHeader) return;
                if (!subject && item && lastSubject) subject = lastSubject;
                if (subject) lastSubject = subject;
                if (item && (subject || lastSubject)) {
                    rows.push({ subject: subject || lastSubject, item, rowIndex: index + 1 });
                }
            });
            if (rows.length > 0) {
                sheetsData.push({ universityName: this.normalizeText(sheetName), rows });
            }
        });
        return sheetsData;
    },

    showToast(message, type) {
        const container = document.getElementById('toast-container');
        if (!container) { alert(message); return; }
        const toast = document.createElement('div');
        toast.className = `toast ${type || 'info'}`;
        toast.innerHTML = `<div class="toast-message">${message}</div>`;
        container.appendChild(toast);
        setTimeout(() => { toast.style.animation = 'toastSlideIn 0.3s ease-out reverse'; setTimeout(() => toast.remove(), 300); }, 3000);
    },

    showLoading(show) {
        const overlay = document.getElementById('loading-overlay');
        if (!overlay) return;
        if (show) overlay.classList.add('active');
        else overlay.classList.remove('active');
    },

    async importXlsx(file) {
        try {
            if (typeof XLSX === 'undefined') {
                this.showToast('Bibliothèque Excel non chargée. Vérifiez votre connexion.', 'error');
                return;
            }
            this.showLoading(true);
            this.showToast('Import en cours...', 'info');

            const workbook = await this.parseExcelFile(file);
            const sheetsData = this.extractSheetsData(workbook);

            if (sheetsData.length === 0) {
                this.showToast('Aucune donnée valide trouvée (colonnes Matière / Fiche attendues)', 'error');
                this.showLoading(false);
                return;
            }

            // Récupérer ou créer les données
            let data = (typeof App !== 'undefined' && App.data) ? App.data : null;
            if (!data || !data.universities) {
                data = {
                    version: 1,
                    updatedAt: new Date().toISOString(),
                    ui: { activeUniversityId: null, filters: {}, view: 'table' },
                    universities: []
                };
            }

            let totalImported = 0;
            let totalCreated = 0;

            for (const sheetData of sheetsData) {
                let university = data.universities.find(u => u.name.toLowerCase() === sheetData.universityName.toLowerCase());
                if (!university) {
                    university = { id: this.generateId(), name: sheetData.universityName, subjects: [], items: [] };
                    data.universities.push(university);
                    if (typeof DataService !== 'undefined' && DataService.upsertUniversity) {
                        await DataService.upsertUniversity(university.id, university.name);
                    }
                }
                data.ui.activeUniversityId = university.id;

                const subjectMap = new Map();
                (university.subjects || []).forEach(s => subjectMap.set(s.name.toLowerCase().trim(), s));
                const existingKeys = new Set();
                (university.items || []).forEach(i => existingKeys.add(`${i.subjectId}-${i.title}`));

                for (const row of sheetData.rows) {
                    const subjectName = row.subject.toLowerCase().trim();
                    let subject = subjectMap.get(subjectName);
                    if (!subject) {
                        subject = { id: this.generateId(), name: row.subject.trim(), owner: '', method: '', remark: '' };
                        university.subjects.push(subject);
                        subjectMap.set(subjectName, subject);
                    }
                    const itemTitle = row.item.trim();
                    const key = `${subject.id}-${itemTitle}`;
                    if (!existingKeys.has(key)) {
                        const newItem = {
                            id: this.generateId(),
                            subjectId: subject.id,
                            subjectNameCache: subject.name,
                            title: itemTitle,
                            status: 'EN_ATTENTE',
                            priority: 'MOYENNE',
                            deadline: '',
                            progress: 0,
                            comment: '',
                            professor: '',
                            updatedAt: new Date().toISOString()
                        };
                        university.items.push(newItem);
                        existingKeys.add(key);
                        totalCreated++;
                    }
                    totalImported++;
                }

                // Persister dans Supabase si disponible
                if (typeof DataService !== 'undefined') {
                    console.log('Import: Persistance Supabase pour', university.name, '- subjects:', university.subjects.length, 'items:', university.items.length);
                    let subjectErrors = 0, itemErrors = 0;
                    for (const subject of university.subjects) {
                        if (DataService.upsertSubject) {
                            const ok = await DataService.upsertSubject(subject.id, university.id, subject);
                            if (!ok) subjectErrors++;
                        }
                    }
                    for (const item of university.items) {
                        if (DataService.upsertItem) {
                            const ok = await DataService.upsertItem(item.id, item.subjectId, item);
                            if (!ok) itemErrors++;
                        }
                    }
                    if (subjectErrors > 0 || itemErrors > 0) {
                        console.warn('Import: Erreurs Supabase - subjects:', subjectErrors, 'items:', itemErrors);
                        this.showToast(`Attention: ${subjectErrors + itemErrors} erreurs de synchronisation`, 'error');
                    } else {
                        console.log('Import: Toutes les données persistées avec succès');
                    }
                } else {
                    console.warn('Import: DataService non disponible, données non persistées');
                }
            }

            // Sauvegarder et mettre à jour l'affichage
            if (typeof App !== 'undefined') {
                App.data = data;
                if (typeof Storage !== 'undefined' && Storage.saveData) Storage.saveData(data);
                if (App.render) App.render();
            }

            this.showToast(`Import réussi : ${totalCreated} nouvelles fiches créées sur ${totalImported} lignes`, 'success');
            this.showLoading(false);

            const modalImport = document.getElementById('modal-import-excel');
            if (modalImport) modalImport.classList.remove('active');
        } catch (error) {
            console.error('Error importing Excel:', error);
            this.showToast('Erreur import Excel: ' + (error && error.message ? error.message : 'voir console'), 'error');
            this.showLoading(false);
        }
    }
};

// Gestionnaire global pour l'import Excel
window.handleExcelFile = function (file) {
    if (!file) return;
    ImportXlsx.importXlsx(file);
};

// Marquer que ImportXlsx est prêt
window._importXlsxReady = true;
console.log('app.js: ImportXlsx prêt');

// Supabase client (webapp collaborative)
const SUPABASE_URL = 'https://irtzfvftvptkpoxbkhmi.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_AYxzqfwYE31c21fuiWRrkw_P0LLhMTl';
let supabaseClient = null;
try {
    if (window.supabase) {
        supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        console.log('Supabase client initialisé avec succès');
    } else {
        console.warn('window.supabase non disponible - mode hors ligne');
    }
} catch (e) {
    console.error('Supabase init error:', e);
}

// ============================================
// DATA SERVICE (Supabase)
// ============================================

const DataService = {
    async fetchAll() {
        if (!supabaseClient) return null;
        try {
            const [uniRes, subjRes, itemRes] = await Promise.all([
                supabaseClient.from('universities').select('id, name, created_at').order('created_at', { ascending: true }),
                supabaseClient.from('subjects').select('id, university_id, name, owner, method, remark, created_at').order('created_at', { ascending: true }),
                supabaseClient.from('items').select('id, subject_id, title, status, priority, deadline, progress, comment, professor, updated_at, created_at').order('created_at', { ascending: true })
            ]);
            if (uniRes.error) throw new Error(uniRes.error?.message || 'universities');
            if (subjRes.error) throw new Error(subjRes.error?.message || 'subjects');
            if (itemRes.error) throw new Error(itemRes.error?.message || 'items');

            const universitiesRows = uniRes.data || [];
            const subjectsRows = subjRes.data || [];
            const itemsRows = itemRes.data || [];

            const subjectById = new Map();
            subjectsRows.forEach(s => {
                subjectById.set(s.id, {
                    id: s.id,
                    name: s.name || '',
                    owner: s.owner || '',
                    method: s.method || '',
                    remark: s.remark || ''
                });
            });

            const subjectsByUniversityId = new Map();
            subjectsRows.forEach(s => {
                const uid = s.university_id;
                if (!subjectsByUniversityId.has(uid)) subjectsByUniversityId.set(uid, []);
                subjectsByUniversityId.get(uid).push(subjectById.get(s.id));
            });

            const itemsBySubjectId = new Map();
            itemsRows.forEach(i => {
                const sid = i.subject_id;
                if (!itemsBySubjectId.has(sid)) itemsBySubjectId.set(sid, []);
                itemsBySubjectId.get(sid).push({
                    id: i.id,
                    subjectId: i.subject_id,
                    subjectNameCache: '',
                    title: i.title || '',
                    status: i.status || 'EN_ATTENTE',
                    priority: i.priority || 'MOYENNE',
                    deadline: i.deadline || '',
                    progress: i.progress != null ? i.progress : 0,
                    comment: i.comment || '',
                    professor: i.professor || '',
                    updatedAt: i.updated_at || new Date().toISOString()
                });
            });

            const universities = universitiesRows.map(u => {
                const subjects = subjectsByUniversityId.get(u.id) || [];
                const subjectIds = new Set(subjects.map(s => s.id));
                const items = [];
                subjects.forEach(s => {
                    (itemsBySubjectId.get(s.id) || []).forEach(it => {
                        it.subjectNameCache = it.subjectNameCache || s.name;
                        items.push(it);
                    });
                });
                return {
                    id: u.id,
                    name: u.name || '',
                    subjects,
                    items
                };
            });

            const firstUniversityId = universities.length > 0 ? universities[0].id : null;
            return {
                version: 1,
                updatedAt: new Date().toISOString(),
                ui: {
                    activeUniversityId: firstUniversityId,
                    filters: { subjectId: '', owner: '', status: '', priority: '', overdueOnly: false, hasDeadline: null },
                    view: 'table'
                },
                universities
            };
        } catch (err) {
            console.error('DataService.fetchAll error:', err);
            return null;
        }
    },

    async upsertUniversity(id, name) {
        if (!supabaseClient) {
            console.log('upsertUniversity: pas de client Supabase');
            return true;
        }
        try {
            console.log('upsertUniversity:', id, name);
            const { error } = await supabaseClient.from('universities').upsert({ id, name }, { onConflict: 'id' });
            if (error) console.error('upsertUniversity error:', error);
            return !error;
        } catch (e) {
            console.error('DataService.upsertUniversity error:', e);
            return false;
        }
    },

    async deleteUniversity(id) {
        if (!supabaseClient) return true;
        try {
            const { error } = await supabaseClient.from('universities').delete().eq('id', id);
            return !error;
        } catch (e) {
            console.error('DataService.deleteUniversity error:', e);
            return false;
        }
    },

    async upsertSubject(id, universityId, { name, owner, method, remark }) {
        if (!supabaseClient) {
            console.log('upsertSubject: pas de client Supabase');
            return true;
        }
        try {
            console.log('upsertSubject:', id, 'univ:', universityId, 'name:', name);
            const { error } = await supabaseClient.from('subjects').upsert({
                id,
                university_id: universityId,
                name: name || '',
                owner: owner || '',
                method: method || '',
                remark: remark || ''
            }, { onConflict: 'id' });
            if (error) console.error('upsertSubject error:', error);
            return !error;
        } catch (e) {
            console.error('DataService.upsertSubject error:', e);
            return false;
        }
    },

    async deleteSubject(id) {
        if (!supabaseClient) return true;
        try {
            const { error } = await supabaseClient.from('subjects').delete().eq('id', id);
            return !error;
        } catch (e) {
            console.error('DataService.deleteSubject error:', e);
            return false;
        }
    },

    async upsertItem(id, subjectId, payload) {
        if (!supabaseClient) return true;
        try {
            const row = {
                id,
                subject_id: subjectId,
                title: payload.title || '',
                status: payload.status || 'EN_ATTENTE',
                priority: payload.priority || 'MOYENNE',
                deadline: payload.deadline || null,
                progress: payload.progress != null ? payload.progress : 0,
                comment: payload.comment || '',
                professor: payload.professor || '',
                updated_at: new Date().toISOString()
            };
            const { error } = await supabaseClient.from('items').upsert(row, { onConflict: 'id' });
            if (error) {
                console.error('DataService.upsertItem FULL ERROR:', JSON.stringify(error));
                console.error('DataService.upsertItem ROW DATA:', JSON.stringify(row));
            }
            return !error;
        } catch (e) {
            console.error('DataService.upsertItem error:', e);
            return false;
        }
    },

    async deleteItem(id) {
        if (!supabaseClient) return true;
        try {
            const { error } = await supabaseClient.from('items').delete().eq('id', id);
            return !error;
        } catch (e) {
            console.error('DataService.deleteItem error:', e);
            return false;
        }
    }
};

// ============================================
// STORAGE MODULE
// ============================================

const Storage = {
    loadData() {
        try {
            // Ne lit plus depuis localStorage : les données sont en mémoire (App.data)
            if (typeof App !== 'undefined' && App.data) {
                return App.data;
            }
            return null;
        } catch (error) {
            console.error('Error loading data from memory:', error);
            return null;
        }
    },

    saveData(data) {
        try {
            // Ne persiste plus dans localStorage : App.data est la source en mémoire
            if (typeof App !== 'undefined') {
                App.data = data;
            }
            return true;
        } catch (error) {
            console.error('Error saving data in memory:', error);
            return false;
        }
    },

    migrateData(data) {
        // Pour l'instant, version 1 uniquement
        // Ajouter ici les migrations futures si nécessaire
        return data;
    },

    exportJSON() {
        const data = this.loadData();
        if (!data) {
            this.showToast('Aucune donnée à exporter', 'error');
            return;
        }

        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `dashboard-refonte-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        this.showToast('Export réussi', 'success');
    },

    importJSON(file, mode = 'merge') {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const imported = JSON.parse(e.target.result);
                const current = this.loadData();

                if (mode === 'replace') {
                    this.saveData(imported);
                    this.showToast('Import réussi (remplacement)', 'success');
                } else {
                    // Merge mode
                    const merged = this.mergeData(current, imported);
                    this.saveData(merged);
                    this.showToast('Import réussi (fusion)', 'success');
                }

                // Recharger l'app
                setTimeout(() => {
                    window.location.reload();
                }, 1000);
            } catch (error) {
                console.error('Error importing JSON:', error);
                this.showToast('Erreur lors de l\'import JSON', 'error');
            }
        };
        reader.readAsText(file);
    },

    mergeData(current, imported) {
        if (!current) return imported;

        const merged = {
            version: current.version || 1,
            updatedAt: new Date().toISOString(),
            ui: imported.ui || current.ui,
            universities: []
        };

        // Créer un map des universités existantes
        const universityMap = new Map();
        current.universities?.forEach(u => {
            universityMap.set(u.id, { ...u });
        });

        // Fusionner les universités importées
        imported.universities?.forEach(importedUniv => {
            const existing = universityMap.get(importedUniv.id);
            
            if (existing) {
                // Fusionner les matières
                const subjectMap = new Map();
                existing.subjects?.forEach(s => subjectMap.set(s.id, s));
                
                importedUniv.subjects?.forEach(importedSubject => {
                    const existingSubject = subjectMap.get(importedSubject.id);
                    if (existingSubject) {
                        // Mettre à jour le responsable si fourni
                        if (importedSubject.owner) {
                            existingSubject.owner = importedSubject.owner;
                        }
                    } else {
                        existing.subjects.push(importedSubject);
                    }
                });

                // Fusionner les items (fiches)
                const itemMap = new Map();
                existing.items?.forEach(item => {
                    const key = `${item.subjectId}-${item.title}`;
                    itemMap.set(key, item);
                });

                importedUniv.items?.forEach(importedItem => {
                    const key = `${importedItem.subjectId}-${importedItem.title}`;
                    const existingItem = itemMap.get(key);
                    
                    if (existingItem) {
                        // Fusionner : conserver existant, mettre à jour champs vides
                        Object.keys(importedItem).forEach(k => {
                            if (k !== 'id' && k !== 'subjectId' && k !== 'title' && k !== 'subjectNameCache') {
                                if (!existingItem[k] || existingItem[k] === '') {
                                    existingItem[k] = importedItem[k];
                                }
                            }
                        });
                        existingItem.updatedAt = new Date().toISOString();
                    } else {
                        existing.items.push(importedItem);
                    }
                });
            } else {
                // Nouvelle université
                universityMap.set(importedUniv.id, importedUniv);
            }
        });

        merged.universities = Array.from(universityMap.values());
        return merged;
    },

    showToast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        if (!container) return;
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `<div class="toast-message">${message}</div>`;
        container.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'toastSlideIn 0.3s ease-out reverse';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
};

// ============================================
// DATA MODEL & SEED
// ============================================

const DataModel = {
    generateId() {
        // Toujours générer un UUID valide pour Supabase
        if (crypto.randomUUID) {
            return crypto.randomUUID();
        }
        // Fallback: générer un UUID v4 valide
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    },

    getDefaultData() {
        const universityId = this.generateId();
        const subject1Id = this.generateId();
        const subject2Id = this.generateId();

        return {
            version: 1,
            updatedAt: new Date().toISOString(),
            ui: {
                activeUniversityId: universityId,
                filters: {
                    subjectId: '',
                    owner: '',
                    status: '',
                    priority: '',
                    overdueOnly: false,
                    hasDeadline: null
                },
                view: 'table'
            },
            universities: [
                {
                    id: universityId,
                    name: 'Sorbonne Paris Nord',
                    subjects: [
                        {
                            id: subject1Id,
                            name: 'Biochimie',
                            owner: 'Dr. Martin',
                            method: 'NB_AUDIO_AKV',
                            remark: ''
                        },
                        {
                            id: subject2Id,
                            name: 'Anatomie',
                            owner: 'Dr. Dupont',
                            method: 'NB_AUDIO_POLY',
                            remark: ''
                        }
                    ],
                    items: [
                        {
                            id: this.generateId(),
                            subjectId: subject1Id,
                            subjectNameCache: 'Biochimie',
                            title: 'Introduction à la biochimie',
                            status: 'EN_ATTENTE',
                            priority: 'MOYENNE',
                            deadline: '',
                            progress: 0,
                            comment: '',
                            professor: '',
                            updatedAt: new Date().toISOString()
                        },
                        {
                            id: this.generateId(),
                            subjectId: subject1Id,
                            subjectNameCache: 'Biochimie',
                            title: 'Métabolisme cellulaire',
                            status: 'EN_COURS',
                            priority: 'HAUTE',
                            deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
                            progress: 45,
                            comment: 'En cours de rédaction',
                            professor: '',
                            updatedAt: new Date().toISOString()
                        },
                        {
                            id: this.generateId(),
                            subjectId: subject1Id,
                            subjectNameCache: 'Biochimie',
                            title: 'Enzymes et catalyse',
                            status: 'EN_RELECTURE',
                            priority: 'MOYENNE',
                            deadline: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
                            progress: 90,
                            comment: '',
                            professor: '',
                            updatedAt: new Date().toISOString()
                        },
                        {
                            id: this.generateId(),
                            subjectId: subject2Id,
                            subjectNameCache: 'Anatomie',
                            title: 'Système cardiovasculaire',
                            status: 'VALIDE',
                            priority: 'BASSE',
                            deadline: '',
                            progress: 100,
                            comment: 'Validé par le comité',
                            professor: '',
                            updatedAt: new Date().toISOString()
                        },
                        {
                            id: this.generateId(),
                            subjectId: subject2Id,
                            subjectNameCache: 'Anatomie',
                            title: 'Système respiratoire',
                            status: 'EN_COURS',
                            priority: 'HAUTE',
                            deadline: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
                            progress: 30,
                            comment: '',
                            professor: '',
                            updatedAt: new Date().toISOString()
                        },
                        {
                            id: this.generateId(),
                            subjectId: subject2Id,
                            subjectNameCache: 'Anatomie',
                            title: 'Système digestif',
                            status: 'EN_ATTENTE',
                            priority: 'MOYENNE',
                            deadline: '',
                            progress: 0,
                            comment: '',
                            professor: '',
                            updatedAt: new Date().toISOString()
                        }
                    ]
                }
            ]
        };
    },

    initData() {
        let data = Storage.loadData();
        if (!data) {
            data = this.getDefaultData();
            Storage.saveData(data);
        }
        return data;
    }
};

// ============================================
// SELECTORS & COMPUTED
// ============================================

const Selectors = {
    getActiveUniversity(data) {
        if (!data || !data.ui.activeUniversityId) return null;
        return data.universities.find(u => u.id === data.ui.activeUniversityId) || null;
    },

    getFilteredItems(data) {
        const university = this.getActiveUniversity(data);
        if (!university) return [];

        let items = [...(university.items || [])];
        const filters = data.ui.filters || {};

        // Filtre par matière
        if (filters.subjectId) {
            items = items.filter(item => item.subjectId === filters.subjectId);
        }

        // Filtre par responsable
        if (filters.owner) {
            items = items.filter(item => {
                const subject = university.subjects.find(s => s.id === item.subjectId);
                return subject && subject.owner === filters.owner;
            });
        }

        // Filtre par statut
        if (filters.status) {
            items = items.filter(item => item.status === filters.status);
        }

        // Filtre par priorité
        if (filters.priority) {
            items = items.filter(item => item.priority === filters.priority);
        }

        // Filtre en retard
        if (filters.overdueOnly) {
            items = items.filter(item => Computed.isOverdue(item));
        }

        // Filtre deadline
        if (filters.hasDeadline === true) {
            items = items.filter(item => item.deadline && item.deadline !== '');
        } else if (filters.hasDeadline === false) {
            items = items.filter(item => !item.deadline || item.deadline === '');
        }

        return items;
    },

    getSubjectById(data, subjectId) {
        const university = this.getActiveUniversity(data);
        if (!university) return null;
        return university.subjects.find(s => s.id === subjectId) || null;
    },

    getSubjectOwner(data, subjectId) {
        const subject = this.getSubjectById(data, subjectId);
        return subject ? subject.owner : '';
    },

    getAllOwners(data) {
        const university = this.getActiveUniversity(data);
        if (!university) return [];
        const owners = new Set();
        university.subjects.forEach(s => {
            if (s.owner && s.owner.trim() !== '') {
                owners.add(s.owner);
            }
        });
        return Array.from(owners).sort();
    }
};

const Computed = {
    computeSubjectProgress(data, subjectId) {
        const university = Selectors.getActiveUniversity(data);
        if (!university) return 0;

        const items = university.items.filter(item => item.subjectId === subjectId);
        if (items.length === 0) return 0;

        const total = items.reduce((sum, item) => {
            // Si validé, progress = 100
            const progress = item.status === 'VALIDE' ? 100 : (item.progress || 0);
            return sum + progress;
        }, 0);

        return Math.round(total / items.length);
    },

    computeKPIs(data) {
        const university = Selectors.getActiveUniversity(data);
        if (!university) {
            return {
                total: 0,
                validated: 0,
                validatedPercent: 0,
                overdue: 0,
                byStatus: {
                    EN_ATTENTE: 0,
                    EN_COURS: 0,
                    EN_RELECTURE: 0,
                    VALIDE: 0
                },
                averageProgress: 0
            };
        }

        const items = Selectors.getFilteredItems(data);
        const total = items.length;
        const validated = items.filter(item => item.status === 'VALIDE').length;
        const validatedPercent = total > 0 ? Math.round((validated / total) * 100) : 0;
        const overdue = items.filter(item => this.isOverdue(item)).length;

        const byStatus = {
            EN_ATTENTE: items.filter(i => i.status === 'EN_ATTENTE').length,
            EN_COURS: items.filter(i => i.status === 'EN_COURS').length,
            EN_RELECTURE: items.filter(i => i.status === 'EN_RELECTURE').length,
            VALIDE: validated
        };

        const totalProgress = items.reduce((sum, item) => {
            const progress = item.status === 'VALIDE' ? 100 : (item.progress || 0);
            return sum + progress;
        }, 0);
        const averageProgress = total > 0 ? Math.round(totalProgress / total) : 0;

        return {
            total,
            validated,
            validatedPercent,
            overdue,
            byStatus,
            averageProgress
        };
    },

    isOverdue(item) {
        if (!item.deadline || item.deadline === '') return false;
        if (item.status === 'VALIDE') return false;
        
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const deadline = new Date(item.deadline);
        deadline.setHours(0, 0, 0, 0);
        
        return deadline < today;
    },

    getNearestDeadlineForSubject(data, subjectId) {
        const university = Selectors.getActiveUniversity(data);
        if (!university) return null;

        const items = university.items
            .filter(item => item.subjectId === subjectId && item.deadline && item.deadline !== '')
            .map(item => ({
                ...item,
                deadlineDate: new Date(item.deadline)
            }))
            .filter(item => !isNaN(item.deadlineDate.getTime()))
            .sort((a, b) => a.deadlineDate - b.deadlineDate);

        return items.length > 0 ? items[0] : null;
    }
};

// ============================================
// RENDER MODULE
// ============================================

const Render = {
    renderTabs(data) {
        const container = document.getElementById('tabs-container');
        if (!container) return;

        const tabs = document.createElement('div');
        tabs.className = 'tabs';

        data.universities.forEach(university => {
            const tabWrapper = document.createElement('div');
            tabWrapper.className = 'tab-wrapper';
            tabWrapper.style.display = 'flex';
            tabWrapper.style.alignItems = 'center';
            tabWrapper.style.gap = 'var(--spacing-xs)';

            const tab = document.createElement('button');
            tab.className = `tab ${university.id === data.ui.activeUniversityId ? 'active' : ''}`;
            tab.textContent = university.name;
            tab.dataset.universityId = university.id;
            tabWrapper.appendChild(tab);

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'btn btn-icon btn-sm btn-action-delete-tab';
            deleteBtn.innerHTML = '🗑️';
            deleteBtn.title = 'Supprimer cette université';
            deleteBtn.dataset.action = 'delete-university';
            deleteBtn.dataset.universityId = university.id;
            deleteBtn.style.display = 'flex';
            deleteBtn.style.alignItems = 'center';
            deleteBtn.style.justifyContent = 'center';
            tabWrapper.appendChild(deleteBtn);

            tabs.appendChild(tabWrapper);
        });

        container.innerHTML = '';
        container.appendChild(tabs);
    },

    renderKPIs(data) {
        const container = document.getElementById('kpi-section');
        if (!container) return;

        const kpis = Computed.computeKPIs(data);

        const html = `
            <div class="kpi-grid">
                <div class="kpi-card">
                    <div class="kpi-label">Total fiches</div>
                    <div class="kpi-value">${kpis.total}</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-label">Validé</div>
                    <div class="kpi-value">${kpis.validatedPercent}%</div>
                    <div class="kpi-change">${kpis.validated} fiches</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-label">En retard</div>
                    <div class="kpi-value" style="color: var(--danger);">${kpis.overdue}</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-label">Progression globale</div>
                    <div class="kpi-value">${kpis.averageProgress}%</div>
                    <div class="progress-bar" style="margin-top: 0.5rem;">
                        <div class="progress-fill" style="width: ${kpis.averageProgress}%"></div>
                    </div>
                </div>
            </div>
            <div style="margin-top: 1.5rem; padding: 1rem; background: var(--surface); border-radius: var(--radius-md); border: 1px solid var(--border);">
                <div style="font-weight: 600; margin-bottom: 0.75rem; font-size: 0.875rem;">Répartition par statut</div>
                <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                    ${STATUSES.map(status => {
                        const count = kpis.byStatus[status];
                        const percent = kpis.total > 0 ? Math.round((count / kpis.total) * 100) : 0;
                        const statusLabels = {
                            EN_ATTENTE: 'En attente',
                            EN_COURS: 'En cours',
                            EN_RELECTURE: 'En relecture',
                            VALIDE: 'Validé'
                        };
                        return `
                            <div style="display: flex; align-items: center; gap: 0.75rem;">
                                <div style="min-width: 100px; font-size: 0.75rem; color: var(--text-muted);">${statusLabels[status]}</div>
                                <div class="progress-bar" style="flex: 1; height: 1.25rem;">
                                    <div class="progress-fill" style="width: ${percent}%; background: var(--${status === 'VALIDE' ? 'success' : status === 'EN_RELECTURE' ? 'warning' : 'info'});"></div>
                                </div>
                                <div style="min-width: 40px; text-align: right; font-size: 0.75rem; font-weight: 600; color: var(--text);">${count}</div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;

        container.innerHTML = html;
    },

    renderFilters(data) {
        const container = document.getElementById('filters-section');
        if (!container) return;

        const university = Selectors.getActiveUniversity(data);
        if (!university) {
            container.innerHTML = '';
            return;
        }

        const filters = data.ui.filters || {};
        const owners = Selectors.getAllOwners(data);

        const html = `
            <div class="filters-bar">
                <div class="filter-group">
                    <label>Recherche</label>
                    <input type="text" id="filter-search" class="search-input" placeholder="Matière ou fiche...">
                </div>
                <div class="filter-group">
                    <label>Matière</label>
                    <select id="filter-subject">
                        <option value="">Toutes</option>
                        ${university.subjects.map(s => `
                            <option value="${s.id}" ${filters.subjectId === s.id ? 'selected' : ''}>${s.name}</option>
                        `).join('')}
                    </select>
                </div>
                <div class="filter-group">
                    <label>Responsable</label>
                    <select id="filter-owner">
                        <option value="">Tous</option>
                        ${owners.map(o => `
                            <option value="${o}" ${filters.owner === o ? 'selected' : ''}>${o}</option>
                        `).join('')}
                    </select>
                </div>
                <div class="filter-group">
                    <label>Statut</label>
                    <select id="filter-status">
                        <option value="">Tous</option>
                        <option value="EN_ATTENTE" ${filters.status === 'EN_ATTENTE' ? 'selected' : ''}>En attente</option>
                        <option value="EN_COURS" ${filters.status === 'EN_COURS' ? 'selected' : ''}>En cours</option>
                        <option value="EN_RELECTURE" ${filters.status === 'EN_RELECTURE' ? 'selected' : ''}>En relecture</option>
                        <option value="VALIDE" ${filters.status === 'VALIDE' ? 'selected' : ''}>Validé</option>
                    </select>
                </div>
                <div class="filter-group">
                    <label>Priorité</label>
                    <select id="filter-priority">
                        <option value="">Toutes</option>
                        <option value="HAUTE" ${filters.priority === 'HAUTE' ? 'selected' : ''}>Haute</option>
                        <option value="MOYENNE" ${filters.priority === 'MOYENNE' ? 'selected' : ''}>Moyenne</option>
                        <option value="BASSE" ${filters.priority === 'BASSE' ? 'selected' : ''}>Basse</option>
                    </select>
                </div>
                <div class="filter-group">
                    <label style="margin-bottom: 0.5rem;">Options</label>
                    <div class="toggle">
                        <input type="checkbox" id="filter-overdue" ${filters.overdueOnly ? 'checked' : ''}>
                        <label for="filter-overdue" style="font-size: 0.875rem; cursor: pointer;">En retard uniquement</label>
                    </div>
                    <div class="toggle" style="margin-top: 0.5rem;">
                        <input type="checkbox" id="filter-has-deadline" ${filters.hasDeadline === true ? 'checked' : ''}>
                        <label for="filter-has-deadline" style="font-size: 0.875rem; cursor: pointer;">Avec deadline</label>
                    </div>
                </div>
                <div class="filter-actions">
                    <button class="btn btn-secondary" id="btn-reset-filters">Réinitialiser</button>
                </div>
            </div>
        `;

        container.innerHTML = html;
    },

    renderTable(data, searchTerm = '', sortColumn = null, sortDirection = 'asc') {
        const container = document.getElementById('view-content');
        if (!container) return;

        const items = Selectors.getFilteredItems(data);
        const university = Selectors.getActiveUniversity(data);
        if (!university) {
            container.innerHTML = '<p class="text-center text-muted">Aucune université sélectionnée</p>';
            return;
        }

        // Filtrer par recherche
        let filteredItems = items;
        if (searchTerm) {
            const term = searchTerm.toLowerCase();
            filteredItems = items.filter(item => {
                const subject = university.subjects.find(s => s.id === item.subjectId);
                const subjectName = subject ? subject.name.toLowerCase() : '';
                const itemTitle = item.title.toLowerCase();
                return subjectName.includes(term) || itemTitle.includes(term);
            });
        }

        // Trier
        if (sortColumn) {
            filteredItems.sort((a, b) => {
                let aVal, bVal;
                switch (sortColumn) {
                    case 'title':
                        aVal = a.title.toLowerCase();
                        bVal = b.title.toLowerCase();
                        break;
                    case 'status':
                        aVal = STATUSES.indexOf(a.status);
                        bVal = STATUSES.indexOf(b.status);
                        break;
                    case 'priority':
                        aVal = PRIORITIES.indexOf(a.priority);
                        bVal = PRIORITIES.indexOf(b.priority);
                        break;
                    case 'deadline':
                        aVal = a.deadline ? new Date(a.deadline).getTime() : 0;
                        bVal = b.deadline ? new Date(b.deadline).getTime() : 0;
                        break;
                    case 'progress':
                        aVal = a.status === 'VALIDE' ? 100 : (a.progress || 0);
                        bVal = b.status === 'VALIDE' ? 100 : (b.progress || 0);
                        break;
                    default:
                        return 0;
                }
                
                if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
                if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
                return 0;
            });
        }

        // Grouper par matière
        const groupedBySubject = new Map();
        filteredItems.forEach(item => {
            if (!groupedBySubject.has(item.subjectId)) {
                groupedBySubject.set(item.subjectId, []);
            }
            groupedBySubject.get(item.subjectId).push(item);
        });

        // Mode groupé
        const html = `
            <div class="search-bar">
                <input type="text" id="table-search" class="search-input" placeholder="Rechercher par matière ou fiche..." value="${searchTerm}">
            </div>
            <div class="table-groups">
                ${Array.from(groupedBySubject.entries()).map(([subjectId, subjectItems]) => {
                    const subject = university.subjects.find(s => s.id === subjectId);
                    const subjectName = subject ? subject.name : 'Inconnu';
                    const owner = subject ? subject.owner : '';
                    const progress = Computed.computeSubjectProgress(data, subjectId);
                    const methodLabel = subject && subject.method === 'NB_AUDIO_AKV'
                        ? 'NB + audio + AKV'
                        : subject && subject.method === 'NB_AUDIO_POLY'
                            ? 'NB + audio + poly'
                            : subject && subject.method === 'NB_AUDIO_POLY_ACC'
                                ? 'NB + audio + poly + ACC'
                                : '';
                    
                    return `
                        <div class="table-group">
                            <div class="table-group-header" data-subject-id="${subjectId}">
                                <div style="flex: 1;">
                                    <h3>${subjectName}</h3>
                                    <div class="table-group-info">
                                        ${owner ? `<span>👤 ${owner}</span>` : ''}
                                        ${methodLabel ? `<span>⚙️ ${methodLabel}</span>` : ''}
                                        ${subject && subject.remark ? `<span>📝 ${Render.escapeHtml(subject.remark)}</span>` : ''}
                                        <span>📊 ${progress}%</span>
                                        <span>📝 ${subjectItems.length} fiche${subjectItems.length > 1 ? 's' : ''}</span>
                                    </div>
                                </div>
                                <div style="display: flex; align-items: center; gap: var(--spacing-sm);">
                                    <div class="progress-bar" style="width: 200px;">
                                        <div class="progress-fill" style="width: ${progress}%"></div>
                                    </div>
                                    <div class="table-group-actions" style="display: flex; gap: var(--spacing-xs);">
                                        <button class="btn btn-sm btn-action" data-action="subject-deadline" data-subject-id="${subjectId}" title="Définir deadline">
                                            📅
                                        </button>
                                        <button class="btn btn-sm btn-action" data-action="subject-owner" data-subject-id="${subjectId}" title="Assigner responsable / méthode / remarque">
                                            👤
                                        </button>
                                        <button class="btn btn-sm btn-action-delete" data-action="subject-delete" data-subject-id="${subjectId}" title="Supprimer matière">
                                            🗑️
                                        </button>
                                    </div>
                                </div>
                            </div>
                            <div class="table-group-content" data-subject-content="${subjectId}">
                                <div class="table-container">
                                    <table class="table">
                                        <thead>
                                            <tr>
                                                <th class="sortable ${sortColumn === 'title' ? `sort-${sortDirection}` : ''}" data-sort="title">Fiche/Chapitre</th>
                                                <th>Prof. amphi</th>
                                                <th class="sortable ${sortColumn === 'status' ? `sort-${sortDirection}` : ''}" data-sort="status">Statut</th>
                                                <th class="sortable ${sortColumn === 'priority' ? `sort-${sortDirection}` : ''}" data-sort="priority">Priorité</th>
                                                <th>Responsable</th>
                                                <th class="sortable ${sortColumn === 'deadline' ? `sort-${sortDirection}` : ''}" data-sort="deadline">Deadline</th>
                                                <th class="sortable ${sortColumn === 'progress' ? `sort-${sortDirection}` : ''}" data-sort="progress">Avancement</th>
                                                <th>Remarque</th>
                                                <th>Tag</th>
                                                <th>Dernière MAJ</th>
                                                <th>Actions</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            ${subjectItems.map(item => this.renderTableRow(item, owner)).join('')}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;

        container.innerHTML = html;
    },

    renderTableRow(item, owner) {
        const statusLabels = {
            EN_ATTENTE: 'En attente',
            EN_COURS: 'En cours',
            EN_RELECTURE: 'En relecture',
            VALIDE: 'Validé'
        };
        const priorityLabels = {
            HAUTE: 'Haute',
            MOYENNE: 'Moyenne',
            BASSE: 'Basse'
        };

        const isOverdue = Computed.isOverdue(item);
        const progress = item.status === 'VALIDE' ? 100 : item.progress;
        const updatedDate = item.updatedAt ? new Date(item.updatedAt).toLocaleDateString('fr-FR') : '';

        return `
            <tr>
                <td>${this.escapeHtml(item.title)}</td>
                <td>${item.professor ? this.escapeHtml(item.professor) : '-'}</td>
                <td><span class="badge badge-status ${item.status.toLowerCase().replace('_', '-')}">${statusLabels[item.status]}</span></td>
                <td><span class="badge badge-priority ${item.priority.toLowerCase()}">${priorityLabels[item.priority]}</span></td>
                <td>${owner || '-'}</td>
                <td>${item.deadline ? new Date(item.deadline).toLocaleDateString('fr-FR') : '-'}</td>
                <td>
                    <div style="display: flex; align-items: center; gap: 0.5rem;">
                        <div class="progress-bar" style="flex: 1; min-width: 80px;">
                            <div class="progress-fill ${progress === 100 ? 'success' : progress < 50 ? 'warning' : ''}" style="width: ${progress}%"></div>
                        </div>
                        <span style="font-size: 0.75rem; font-weight: 600; min-width: 35px;">${progress}%</span>
                    </div>
                </td>
                <td>${item.comment ? this.escapeHtml(item.comment) : '-'}</td>
                <td>${isOverdue ? '<span class="badge badge-overdue">En retard</span>' : '-'}</td>
                <td class="text-small text-muted">${updatedDate}</td>
                <td>
                    <div class="table-actions">
                        <button class="btn btn-sm btn-secondary" data-action="edit" data-item-id="${item.id}">✏️</button>
                        <button class="btn btn-sm btn-danger" data-action="delete" data-item-id="${item.id}">🗑️</button>
                    </div>
                </td>
            </tr>
        `;
    },

    renderKanban(data) {
        const container = document.getElementById('view-content');
        if (!container) return;

        const items = Selectors.getFilteredItems(data);
        const university = Selectors.getActiveUniversity(data);
        if (!university) {
            container.innerHTML = '<p class="text-center text-muted">Aucune université sélectionnée</p>';
            return;
        }

        const statusColumns = [
            { status: 'EN_ATTENTE', label: 'En attente' },
            { status: 'EN_COURS', label: 'En cours' },
            { status: 'EN_RELECTURE', label: 'En relecture' },
            { status: 'VALIDE', label: 'Validé' }
        ];

        const html = `
            <div class="kanban-container">
                ${statusColumns.map(column => {
                    const columnItems = items.filter(item => item.status === column.status);
                    
                    return `
                        <div class="kanban-column" data-status="${column.status}">
                            <div class="kanban-column-header">
                                <div class="kanban-column-title">${column.label}</div>
                                <div class="kanban-column-count">${columnItems.length}</div>
                            </div>
                            <div class="kanban-cards" data-drop-zone="${column.status}">
                                ${columnItems.map(item => this.renderKanbanCard(item, university)).join('')}
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;

        container.innerHTML = html;
    },

    renderKanbanCard(item, university) {
        const subject = university.subjects.find(s => s.id === item.subjectId);
        const subjectName = subject ? subject.name : 'Inconnu';
        const owner = subject ? subject.owner : '';
        const isOverdue = Computed.isOverdue(item);
        const progress = item.status === 'VALIDE' ? 100 : item.progress;
        const priorityLabels = {
            HAUTE: 'Haute',
            MOYENNE: 'Moyenne',
            BASSE: 'Basse'
        };

        return `
            <div class="kanban-card" draggable="true" data-item-id="${item.id}">
                <div class="kanban-card-header">
                    <div>
                        <div class="kanban-card-subject">${this.escapeHtml(subjectName)}</div>
                        <div class="kanban-card-title">${this.escapeHtml(item.title)}</div>
                    </div>
                    <span class="badge badge-priority ${item.priority.toLowerCase()}">${priorityLabels[item.priority]}</span>
                </div>
                ${item.deadline ? `<div style="font-size: 0.75rem; color: var(--text-muted); margin: 0.5rem 0;">📅 ${new Date(item.deadline).toLocaleDateString('fr-FR')}</div>` : ''}
                <div class="progress-bar" style="margin: 0.5rem 0;">
                    <div class="progress-fill ${progress === 100 ? 'success' : ''}" style="width: ${progress}%"></div>
                </div>
                <div style="font-size: 0.75rem; color: var(--text-muted);">${progress}%</div>
                ${isOverdue ? '<div style="margin-top: 0.5rem;"><span class="badge badge-overdue">En retard</span></div>' : ''}
                <div class="kanban-card-footer">
                    <div style="font-size: 0.75rem; color: var(--text-muted);">${owner || 'Non assigné'}</div>
                    <button class="btn btn-sm btn-secondary" data-action="edit" data-item-id="${item.id}">✏️</button>
                </div>
            </div>
        `;
    },

    renderCalendar(data, month = null, year = null) {
        const container = document.getElementById('view-content');
        if (!container) return;

        const items = Selectors.getFilteredItems(data);
        const university = Selectors.getActiveUniversity(data);
        if (!university) {
            container.innerHTML = '<p class="text-center text-muted">Aucune université sélectionnée</p>';
            return;
        }

        // Utiliser les paramètres ou les valeurs par défaut
        const today = new Date();
        const currentMonth = month !== null ? month : today.getMonth();
        const currentYear = year !== null ? year : today.getFullYear();

        // Créer le calendrier
        const firstDay = new Date(currentYear, currentMonth, 1);
        const lastDay = new Date(currentYear, currentMonth + 1, 0);
        const daysInMonth = lastDay.getDate();
        const startingDayOfWeek = firstDay.getDay();
        const adjustedStartingDay = startingDayOfWeek === 0 ? 6 : startingDayOfWeek - 1; // Lundi = 0

        // Grouper les items par date
        const itemsByDate = new Map();
        items.forEach(item => {
            if (item.deadline && item.deadline !== '') {
                const date = item.deadline;
                if (!itemsByDate.has(date)) {
                    itemsByDate.set(date, []);
                }
                itemsByDate.get(date).push(item);
            }
        });

        // Ajouter les deadlines par matière (deadline la plus proche)
        const subjectsWithDeadlines = new Set();
        university.subjects.forEach(subject => {
            const nearest = Computed.getNearestDeadlineForSubject(data, subject.id);
            if (nearest) {
                const date = nearest.deadline;
                if (!itemsByDate.has(date)) {
                    itemsByDate.set(date, []);
                }
                // Marquer comme deadline de matière
                itemsByDate.get(date).push({
                    ...nearest,
                    isSubjectDeadline: true,
                    subjectName: subject.name
                });
            }
        });

        const monthNames = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
        const dayNames = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

        let calendarHTML = `
            <div class="calendar-container">
                <div class="calendar-header">
                    <div class="calendar-nav">
                        <button class="btn btn-secondary" id="calendar-prev">←</button>
                        <div class="calendar-month-year">${monthNames[currentMonth]} ${currentYear}</div>
                        <button class="btn btn-secondary" id="calendar-next">→</button>
                    </div>
                </div>
                <div class="calendar-grid">
        `;

        // Headers des jours
        dayNames.forEach(day => {
            calendarHTML += `<div class="calendar-day-header">${day}</div>`;
        });

        // Jours du mois précédent (optionnel, pour compléter la grille)
        for (let i = 0; i < adjustedStartingDay; i++) {
            const prevDate = new Date(currentYear, currentMonth, -i);
            calendarHTML += `<div class="calendar-day other-month"></div>`;
        }

        // Jours du mois
        for (let day = 1; day <= daysInMonth; day++) {
            const date = new Date(currentYear, currentMonth, day);
            const dateStr = date.toISOString().split('T')[0];
            const isToday = dateStr === today.toISOString().split('T')[0];
            const dayEvents = itemsByDate.get(dateStr) || [];

            calendarHTML += `
                <div class="calendar-day ${isToday ? 'today' : ''}" data-date="${dateStr}">
                    <div class="calendar-day-number">${day}</div>
                    <div class="calendar-events">
                        ${dayEvents.slice(0, 3).map(event => {
                            const isOverdue = event.isSubjectDeadline ? false : Computed.isOverdue(event);
                            const className = event.isSubjectDeadline ? 'subject' : (isOverdue ? 'overdue' : '');
                            const title = event.isSubjectDeadline ? `${event.subjectName} (matière)` : event.title;
                            return `<div class="calendar-event ${className}" data-item-id="${event.id}" title="${this.escapeHtml(title)}">${this.escapeHtml(title.length > 15 ? title.substring(0, 15) + '...' : title)}</div>`;
                        }).join('')}
                        ${dayEvents.length > 3 ? `<div class="calendar-event" style="background: var(--text-muted);">+${dayEvents.length - 3}</div>` : ''}
                    </div>
                </div>
            `;
        }

        // Compléter avec les jours du mois suivant si nécessaire
        const totalCells = adjustedStartingDay + daysInMonth;
        const remainingCells = 7 - (totalCells % 7);
        if (remainingCells < 7) {
            for (let i = 1; i <= remainingCells; i++) {
                calendarHTML += `<div class="calendar-day other-month"></div>`;
            }
        }

        calendarHTML += `
                </div>
            </div>
        `;

        container.innerHTML = calendarHTML;
    },

    renderModalEdit(item, data) {
        const modal = document.getElementById('modal-edit-item');
        if (!modal) return;

        const university = Selectors.getActiveUniversity(data);
        const subject = university ? university.subjects.find(s => s.id === item.subjectId) : null;

        document.getElementById('edit-item-id').value = item.id;
        document.getElementById('edit-subject').value = subject ? subject.name : '';
        document.getElementById('edit-title').value = item.title;
        document.getElementById('edit-status').value = item.status;
        document.getElementById('edit-priority').value = item.priority;
        document.getElementById('edit-deadline').value = item.deadline || '';
        document.getElementById('edit-progress').value = item.progress || 0;
        document.getElementById('edit-comment').value = item.comment || '';
        const professorInput = document.getElementById('edit-professor');
        if (professorInput) {
            professorInput.value = item.professor || '';
        }

        // Mettre à jour la barre de progression visuelle
        const progress = item.status === 'VALIDE' ? 100 : (item.progress || 0);
        document.getElementById('progress-visual').style.width = `${progress}%`;

        // Désactiver progress si validé
        if (item.status === 'VALIDE') {
            document.getElementById('edit-progress').disabled = true;
        } else {
            document.getElementById('edit-progress').disabled = false;
        }

        modal.classList.add('active');
    },

    renderModalOwner(subjectId, data) {
        const modal = document.getElementById('modal-assign-owner');
        if (!modal) return;

        const university = Selectors.getActiveUniversity(data);
        const subject = university ? university.subjects.find(s => s.id === subjectId) : null;

        if (!subject) return;

        document.getElementById('assign-owner-subject-id').value = subjectId;
        document.getElementById('assign-owner-subject').value = subject.name;
        document.getElementById('assign-owner-name').value = subject.owner || '';

        // Mettre à jour les suggestions
        const datalist = document.getElementById('owner-suggestions');
        const owners = Selectors.getAllOwners(data);
        datalist.innerHTML = owners.map(o => `<option value="${o}">`).join('');

        // Méthode + remarque matière
        const methodSelect = document.getElementById('assign-method');
        const remarkTextarea = document.getElementById('assign-remark');
        if (methodSelect) {
            methodSelect.value = subject.method || '';
        }
        if (remarkTextarea) {
            remarkTextarea.value = subject.remark || '';
        }

        modal.classList.add('active');
    },

    renderModalSubjectDeadline(subjectId, data) {
        const modal = document.getElementById('modal-subject-deadline');
        if (!modal) return;

        const university = Selectors.getActiveUniversity(data);
        const subject = university ? university.subjects.find(s => s.id === subjectId) : null;

        if (!subject) return;

        document.getElementById('subject-deadline-subject-id').value = subjectId;
        document.getElementById('subject-deadline-subject').value = subject.name;
        document.getElementById('subject-deadline-date').value = '';

        modal.classList.add('active');
    },

    renderModalDeleteSubject(subjectId, data) {
        const modal = document.getElementById('modal-delete-subject');
        if (!modal) return;

        const university = Selectors.getActiveUniversity(data);
        const subject = university ? university.subjects.find(s => s.id === subjectId) : null;

        if (!subject) return;

        document.getElementById('delete-subject-id').value = subjectId;
        document.getElementById('delete-subject-name').textContent = subject.name;

        modal.classList.add('active');
    },

    renderModalDeleteUniversity(universityId, universityName, data) {
        const modal = document.getElementById('modal-delete-university');
        if (!modal) return;

        document.getElementById('delete-university-id').value = universityId;
        document.getElementById('delete-university-name').textContent = universityName;

        modal.classList.add('active');
    },

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};

// ============================================
// ACTIONS MODULE
// ============================================

const Actions = {
    async updateItem(itemId, data, updates) {
        const university = Selectors.getActiveUniversity(data);
        if (!university) return false;

        const item = university.items.find(i => i.id === itemId);
        if (!item) return false;

        // Appliquer les mises à jour
        Object.keys(updates).forEach(key => {
            if (key !== 'id' && key !== 'subjectId' && key !== 'title' && key !== 'subjectNameCache') {
                item[key] = updates[key];
            }
        });

        // Règle : si statut = Validé, progress = 100
        if (item.status === 'VALIDE') {
            item.progress = 100;
        }

        item.updatedAt = new Date().toISOString();

        Storage.saveData(data);
        const ok = await DataService.upsertItem(item.id, item.subjectId, item);
        return ok !== false;
    },

    async deleteItem(itemId, data) {
        const university = Selectors.getActiveUniversity(data);
        if (!university) return false;

        const index = university.items.findIndex(i => i.id === itemId);
        if (index === -1) return false;

        university.items.splice(index, 1);
        Storage.saveData(data);
        const ok = await DataService.deleteItem(itemId);
        return ok !== false;
    },

    async assignOwnerToSubject(subjectId, owner, method, remark, data) {
        const university = Selectors.getActiveUniversity(data);
        if (!university) return false;

        const subject = university.subjects.find(s => s.id === subjectId);
        if (!subject) return false;

        subject.owner = (owner || '').trim();
        subject.method = method || '';
        subject.remark = remark || '';
        Storage.saveData(data);
        const ok = await DataService.upsertSubject(subjectId, university.id, { name: subject.name, owner: subject.owner, method: subject.method, remark: subject.remark });
        return ok !== false;
    },

    async moveItemStatus(itemId, newStatus, data) {
        return this.updateItem(itemId, data, { status: newStatus });
    },

    setActiveUniversity(universityId, data) {
        data.ui.activeUniversityId = universityId;
        Storage.saveData(data);
    },

    applyFilter(filterType, value, data) {
        if (!data.ui.filters) {
            data.ui.filters = {};
        }

        if (filterType === 'overdueOnly' || filterType === 'hasDeadline') {
            data.ui.filters[filterType] = value;
        } else {
            data.ui.filters[filterType] = value || '';
        }

        Storage.saveData(data);
    },

    toggleView(viewName, data) {
        data.ui.view = viewName;
        Storage.saveData(data);
    },

    async setDeadlineForSubject(subjectId, deadline, data) {
        const university = Selectors.getActiveUniversity(data);
        if (!university) return false;

        const items = university.items.filter(item => item.subjectId === subjectId);
        if (items.length === 0) return false;

        items.forEach(item => {
            item.deadline = deadline;
            item.updatedAt = new Date().toISOString();
        });

        Storage.saveData(data);
        for (const item of items) {
            await DataService.upsertItem(item.id, item.subjectId, item);
        }
        return true;
    },

    async deleteSubject(subjectId, data) {
        const university = Selectors.getActiveUniversity(data);
        if (!university) return false;

        const subjectIndex = university.subjects.findIndex(s => s.id === subjectId);
        if (subjectIndex === -1) return false;

        university.subjects.splice(subjectIndex, 1);
        university.items = university.items.filter(item => item.subjectId !== subjectId);

        Storage.saveData(data);
        const ok = await DataService.deleteSubject(subjectId);
        return ok !== false;
    },

    async deleteUniversity(universityId, data) {
        const index = data.universities.findIndex(u => u.id === universityId);
        if (index === -1) return false;

        data.universities.splice(index, 1);

        if (data.ui.activeUniversityId === universityId) {
            data.ui.activeUniversityId = data.universities.length > 0 ? data.universities[0].id : '';
        }

        Storage.saveData(data);
        const ok = await DataService.deleteUniversity(universityId);
        return ok !== false;
    },

    async deleteAll(data) {
        if (!data) {
            data = Storage.loadData();
        }
        if (!data) {
            return false;
        }

        const ids = (data.universities || []).map(u => u.id);
        for (const id of ids) {
            await DataService.deleteUniversity(id);
        }

        data.universities = [];
        data.ui.activeUniversityId = '';
        data.ui.filters = {
            subjectId: '',
            owner: '',
            status: '',
            priority: '',
            overdueOnly: false,
            hasDeadline: null
        };
        data.ui.view = 'table';

        Storage.saveData(data);
        return true;
    }
};

// ============================================
// INITIALIZATION
// ============================================

const App = {
    data: null,
    currentSearchTerm: '',
    currentCalendarMonth: new Date().getMonth(),
    currentCalendarYear: new Date().getFullYear(),
    tableSort: { column: null, direction: 'asc' },

    async init() {
        try {
            // Ne pas écraser si l'import Excel a déjà rempli App.data
            if (this.data && this.data.universities && this.data.universities.length > 0) {
                this.render();
                this.attachEventListeners();
                return;
            }
            // Charger les données : Supabase si dispo, sinon mémoire / défaut
            const remote = await DataService.fetchAll();
            if (remote && remote.universities && remote.universities.length >= 0) {
                this.data = remote;
                Storage.saveData(this.data);
            } else {
                this.data = DataModel.initData();
            }
        } catch (e) {
            console.error('App.init load error:', e);
            this.data = DataModel.initData();
        }

        // Rendre l'interface
        this.render();

        // Attacher les event listeners (toujours, même si le chargement a échoué)
        this.attachEventListeners();

        // Realtime : recharger les données quand la BDD change (collaboration)
        if (supabaseClient && typeof supabaseClient.channel === 'function') {
            const channel = supabaseClient
                .channel('dashboard-refonte')
                .on('postgres_changes', { event: '*', schema: 'public', table: 'universities' }, () => {
                    if (typeof this.reloadData === 'function') this.reloadData();
                })
                .on('postgres_changes', { event: '*', schema: 'public', table: 'subjects' }, () => {
                    if (typeof this.reloadData === 'function') this.reloadData();
                })
                .on('postgres_changes', { event: '*', schema: 'public', table: 'items' }, () => {
                    if (typeof this.reloadData === 'function') this.reloadData();
                })
                .subscribe();
        }
    },

    async reloadData() {
        const remote = await DataService.fetchAll();
        if (remote && remote.universities) {
            const previousUi = this.data && this.data.ui ? { ...this.data.ui } : null;
            this.data = remote;
            if (previousUi) {
                this.data.ui = previousUi;
            }
            Storage.saveData(this.data);
            this.render();
        }
    },

    render() {
        Render.renderTabs(this.data);
        Render.renderKPIs(this.data);
        Render.renderFilters(this.data);

        // Rendre la vue active
        const view = this.data.ui.view || 'table';
        this.renderView(view);
    },

    renderView(viewName) {
        // Mettre à jour les boutons de vue
        document.querySelectorAll('.view-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === viewName);
        });

        // Rendre la vue
        switch (viewName) {
            case 'table':
                Render.renderTable(this.data, this.currentSearchTerm, this.tableSort.column, this.tableSort.direction);
                break;
            case 'kanban':
                Render.renderKanban(this.data);
                break;
            case 'calendar':
                Render.renderCalendar(this.data, this.currentCalendarMonth, this.currentCalendarYear);
                break;
        }
    },

    attachEventListeners() {
        // Tabs universités
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('tab')) {
                const universityId = e.target.dataset.universityId;
                Actions.setActiveUniversity(universityId, this.data);
                this.data = Storage.loadData();
                this.render();
            }
        });

        // Boutons de vue
        document.querySelectorAll('.view-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const view = btn.dataset.view;
                Actions.toggleView(view, this.data);
                this.data = Storage.loadData();
                this.renderView(view);
            });
        });

        // Import Excel : délégation d'événement pour que le clic ouvre toujours la modale
        document.addEventListener('click', (e) => {
            if (e.target.closest('#btn-import-excel')) {
                e.preventDefault();
                const modal = document.getElementById('modal-import-excel');
                if (modal) modal.classList.add('active');
            }
        });

        const fileInput = document.getElementById('file-input');
        if (fileInput) {
            fileInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) {
                    ImportXlsx.importXlsx(file);
                    fileInput.value = '';
                }
            });
        }

        // Drag & drop Excel
        const dropZone = document.getElementById('drop-zone');
        if (dropZone) {
            ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
                dropZone.addEventListener(eventName, (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                });
            });

            ['dragenter', 'dragover'].forEach(eventName => {
                dropZone.addEventListener(eventName, () => {
                    dropZone.classList.add('drag-over');
                });
            });

            ['dragleave', 'drop'].forEach(eventName => {
                dropZone.addEventListener(eventName, () => {
                    dropZone.classList.remove('drag-over');
                });
            });

            dropZone.addEventListener('drop', (e) => {
                const file = e.dataTransfer.files[0];
                if (file && (file.name.endsWith('.xlsx') || file.name.endsWith('.xls'))) {
                    ImportXlsx.importXlsx(file);
                } else {
                    Storage.showToast('Veuillez déposer un fichier Excel (.xlsx)', 'error');
                }
            });
        }

        // Bouton de rafraîchissement (rechargera depuis Supabase si configuré)
        const refreshBtn = document.getElementById('btn-refresh');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', async () => {
                if (typeof App !== 'undefined' && App.reloadData) {
                    try {
                        await App.reloadData();
                        Storage.showToast('Données rafraîchies', 'success');
                    } catch (e) {
                        console.error(e);
                        Storage.showToast('Erreur lors du rafraîchissement', 'error');
                    }
                }
            });
        }

        // Fermer modals
        document.querySelectorAll('.modal-close, [data-modal]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                if (btn.dataset.modal || btn.classList.contains('modal-close')) {
                    const modalId = btn.dataset.modal || btn.closest('.modal')?.id;
                    if (modalId) {
                        document.getElementById(modalId).classList.remove('active');
                    }
                }
            });
        });

        // Fermer modal en cliquant en dehors
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    modal.classList.remove('active');
                }
            });
        });

        // Filtres
        document.addEventListener('change', (e) => {
            if (e.target.id === 'filter-subject') {
                Actions.applyFilter('subjectId', e.target.value, this.data);
                this.data = Storage.loadData();
                this.render();
            } else if (e.target.id === 'filter-owner') {
                Actions.applyFilter('owner', e.target.value, this.data);
                this.data = Storage.loadData();
                this.render();
            } else if (e.target.id === 'filter-status') {
                Actions.applyFilter('status', e.target.value, this.data);
                this.data = Storage.loadData();
                this.render();
            } else if (e.target.id === 'filter-priority') {
                Actions.applyFilter('priority', e.target.value, this.data);
                this.data = Storage.loadData();
                this.render();
            } else if (e.target.id === 'filter-overdue') {
                Actions.applyFilter('overdueOnly', e.target.checked, this.data);
                this.data = Storage.loadData();
                this.render();
            } else if (e.target.id === 'filter-has-deadline') {
                Actions.applyFilter('hasDeadline', e.target.checked, this.data);
                this.data = Storage.loadData();
                this.render();
            }
        });

        // Recherche table
        document.addEventListener('input', (e) => {
            if (e.target.id === 'table-search') {
                this.currentSearchTerm = e.target.value;
                Render.renderTable(this.data, this.currentSearchTerm, this.tableSort.column, this.tableSort.direction);
            } else if (e.target.id === 'filter-search') {
                this.currentSearchTerm = e.target.value;
                if (this.data.ui.view === 'table') {
                    Render.renderTable(this.data, this.currentSearchTerm, this.tableSort.column, this.tableSort.direction);
                }
            }
        });

        // Réinitialiser filtres
        document.addEventListener('click', (e) => {
            if (e.target.id === 'btn-reset-filters') {
                this.data.ui.filters = {
                    subjectId: '',
                    owner: '',
                    status: '',
                    priority: '',
                    overdueOnly: false,
                    hasDeadline: null
                };
                Storage.saveData(this.data);
                this.data = Storage.loadData();
                this.render();
            }
        });

        // Form édition fiche
        document.getElementById('form-edit-item').addEventListener('submit', async (e) => {
            e.preventDefault();
            const itemId = document.getElementById('edit-item-id').value;
            const updates = {
                status: document.getElementById('edit-status').value,
                priority: document.getElementById('edit-priority').value,
                deadline: document.getElementById('edit-deadline').value,
                progress: parseInt(document.getElementById('edit-progress').value) || 0,
                comment: document.getElementById('edit-comment').value,
                professor: document.getElementById('edit-professor').value
            };

            try {
                const ok = await Actions.updateItem(itemId, this.data, updates);
                // Mettre à jour l'affichage même si Supabase échoue (données locales sauvegardées)
                Storage.showToast(ok ? 'Fiche mise à jour' : 'Fiche mise à jour (hors ligne)', ok ? 'success' : 'info');
                document.getElementById('modal-edit-item').classList.remove('active');
                this.data = Storage.loadData();
                this.render();
            } catch (err) {
                console.error('Erreur updateItem:', err);
                Storage.showToast('Erreur: ' + (err.message || 'voir console'), 'error');
            }
        });

        // Mise à jour progress visuel lors de l'édition
        document.getElementById('edit-progress').addEventListener('input', (e) => {
            const value = parseInt(e.target.value) || 0;
            document.getElementById('progress-visual').style.width = `${value}%`;
        });

        // Désactiver progress si validé
        document.getElementById('edit-status').addEventListener('change', (e) => {
            const isValide = e.target.value === 'VALIDE';
            const progressInput = document.getElementById('edit-progress');
            if (isValide) {
                progressInput.value = 100;
                progressInput.disabled = true;
                document.getElementById('progress-visual').style.width = '100%';
            } else {
                progressInput.disabled = false;
            }
        });

        // Form assignation responsable / méthode / remarque matière
        document.getElementById('form-assign-owner').addEventListener('submit', async (e) => {
            e.preventDefault();
            const subjectId = document.getElementById('assign-owner-subject-id').value;
            const owner = document.getElementById('assign-owner-name').value;
            const methodEl = document.getElementById('assign-method');
            const remarkEl = document.getElementById('assign-remark');
            const method = methodEl ? methodEl.value : '';
            const remark = remarkEl ? remarkEl.value : '';

            const ok = await Actions.assignOwnerToSubject(subjectId, owner, method, remark, this.data);
            if (ok) {
                Storage.showToast('Responsable / méthode / remarque matière assignés', 'success');
                document.getElementById('modal-assign-owner').classList.remove('active');
                this.data = Storage.loadData();
                this.render();
            } else {
                Storage.showToast('Erreur lors de l\'assignation', 'error');
            }
        });

        // Actions sur les items (éditer, supprimer)
        document.addEventListener('click', async (e) => {
            if (e.target.dataset.action === 'edit' || e.target.closest('[data-action="edit"]')) {
                const itemId = e.target.dataset.itemId || e.target.closest('[data-action="edit"]')?.dataset.itemId;
                if (itemId) {
                    const university = Selectors.getActiveUniversity(this.data);
                    const item = university ? university.items.find(i => i.id === itemId) : null;
                    if (item) {
                        Render.renderModalEdit(item, this.data);
                    }
                }
            } else if (e.target.dataset.action === 'delete' || e.target.closest('[data-action="delete"]')) {
                const itemId = e.target.dataset.itemId || e.target.closest('[data-action="delete"]')?.dataset.itemId;
                if (itemId && confirm('Êtes-vous sûr de vouloir supprimer cette fiche ?')) {
                    const ok = await Actions.deleteItem(itemId, this.data);
                    if (ok) {
                        Storage.showToast('Fiche supprimée', 'success');
                        this.data = Storage.loadData();
                        this.render();
                    } else {
                        Storage.showToast('Erreur lors de la suppression', 'error');
                    }
                }
            }
        });

        // Groupes de table (collapsible) - ne pas fermer si on clique sur les boutons d'action
        document.addEventListener('click', (e) => {
            if (e.target.closest('.table-group-actions')) {
                return; // Ne pas gérer le collapse si on clique sur les actions
            }
            if (e.target.classList.contains('table-group-header') || e.target.closest('.table-group-header')) {
                const header = e.target.classList.contains('table-group-header') ? e.target : e.target.closest('.table-group-header');
                const subjectId = header.dataset.subjectId;
                const content = document.querySelector(`[data-subject-content="${subjectId}"]`);
                if (content) {
                    header.classList.toggle('collapsed');
                    content.classList.toggle('collapsed');
                }
            }
        });

        // Actions sur les matières
        document.addEventListener('click', (e) => {
            // Empêcher la propagation pour éviter le collapse
            if (e.target.closest('.table-group-actions')) {
                e.stopPropagation();
            }

            const btn = e.target.closest('[data-action]');
            if (!btn) return;

            const action = btn.dataset.action;
            const subjectId = btn.dataset.subjectId;

            if (action === 'subject-deadline' && subjectId) {
                e.preventDefault();
                e.stopPropagation();
                Render.renderModalSubjectDeadline(subjectId, this.data);
            } else if (action === 'subject-owner' && subjectId) {
                e.preventDefault();
                e.stopPropagation();
                Render.renderModalOwner(subjectId, this.data);
            } else if (action === 'subject-delete' && subjectId) {
                e.preventDefault();
                e.stopPropagation();
                Render.renderModalDeleteSubject(subjectId, this.data);
            }
        });

        // Form deadline matière
        document.getElementById('form-subject-deadline').addEventListener('submit', async (e) => {
            e.preventDefault();
            const subjectId = document.getElementById('subject-deadline-subject-id').value;
            const deadline = document.getElementById('subject-deadline-date').value;

            const ok = await Actions.setDeadlineForSubject(subjectId, deadline, this.data);
            if (ok) {
                Storage.showToast('Deadline appliquée à toutes les fiches de la matière', 'success');
                document.getElementById('modal-subject-deadline').classList.remove('active');
                this.data = Storage.loadData();
                this.render();
            } else {
                Storage.showToast('Erreur lors de l\'application de la deadline', 'error');
            }
        });

        // Confirmation suppression matière
        document.getElementById('btn-confirm-delete-subject').addEventListener('click', async (e) => {
            e.preventDefault();
            const subjectId = document.getElementById('delete-subject-id').value;
            const currentData = Storage.loadData();
            const ok = await Actions.deleteSubject(subjectId, currentData);
            if (ok) {
                Storage.showToast('Matière supprimée', 'success');
                document.getElementById('modal-delete-subject').classList.remove('active');
                this.data = Storage.loadData();
                this.render();
            } else {
                Storage.showToast('Erreur lors de la suppression', 'error');
            }
        });

        // Confirmation suppression université
        document.getElementById('btn-confirm-delete-university').addEventListener('click', async (e) => {
            e.preventDefault();
            const universityId = document.getElementById('delete-university-id').value;
            const currentData = Storage.loadData();
            const ok = await Actions.deleteUniversity(universityId, currentData);
            if (ok) {
                Storage.showToast('Université supprimée', 'success');
                document.getElementById('modal-delete-university').classList.remove('active');
                this.data = Storage.loadData();
                this.render();
            } else {
                Storage.showToast('Erreur lors de la suppression', 'error');
            }
        });

        // Bouton tout supprimer
        const btnDeleteAll = document.getElementById('btn-delete-all');
        if (btnDeleteAll) {
            btnDeleteAll.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (confirm('Êtes-vous sûr de vouloir supprimer TOUTES les données ? Cette action est irréversible.')) {
                    if (confirm('Confirmez une dernière fois : toutes les universités, matières et fiches seront supprimées.')) {
                        const currentData = Storage.loadData();
                        const ok = currentData && (await Actions.deleteAll(currentData));
                        if (ok) {
                            Storage.showToast('Toutes les données ont été supprimées', 'success');
                            this.data = Storage.loadData();
                            if (!this.data || !this.data.universities || this.data.universities.length === 0) {
                                this.data = DataModel.initData();
                            }
                            this.render();
                        } else {
                            Storage.showToast('Erreur lors de la suppression', 'error');
                        }
                    }
                }
            });
        }

        // Action suppression université depuis les tabs
        document.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action="delete-university"]');
            if (btn) {
                e.preventDefault();
                e.stopPropagation();
                const universityId = btn.dataset.universityId;
                const university = this.data.universities.find(u => u.id === universityId);
                if (university) {
                    Render.renderModalDeleteUniversity(universityId, university.name, this.data);
                }
            }
        });

        // Tri des colonnes
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('sortable') || e.target.closest('.sortable')) {
                const th = e.target.classList.contains('sortable') ? e.target : e.target.closest('.sortable');
                const sortKey = th.dataset.sort;
                
                // Réinitialiser les autres colonnes
                document.querySelectorAll('.sortable').forEach(col => {
                    if (col !== th) {
                        col.classList.remove('sort-asc', 'sort-desc');
                    }
                });
                
                // Toggle direction
                if (this.tableSort.column === sortKey) {
                    this.tableSort.direction = this.tableSort.direction === 'asc' ? 'desc' : 'asc';
                } else {
                    this.tableSort.column = sortKey;
                    this.tableSort.direction = 'asc';
                }
                
                th.classList.remove('sort-asc', 'sort-desc');
                th.classList.add(`sort-${this.tableSort.direction}`);
                
                // Re-render table avec tri
                this.renderView('table');
            }
        });

        // Drag & drop Kanban
        let draggedItem = null;
        document.addEventListener('dragstart', (e) => {
            if (e.target.classList.contains('kanban-card')) {
                draggedItem = e.target;
                e.target.classList.add('dragging');
            }
        });

        document.addEventListener('dragend', (e) => {
            if (e.target.classList.contains('kanban-card')) {
                e.target.classList.remove('dragging');
            }
        });

        document.addEventListener('dragover', (e) => {
            if (e.target.classList.contains('kanban-cards') || e.target.closest('.kanban-cards')) {
                e.preventDefault();
                const dropZone = e.target.classList.contains('kanban-cards') ? e.target : e.target.closest('.kanban-cards');
                dropZone.style.backgroundColor = 'var(--brand-lighter)';
            }
        });

        document.addEventListener('dragleave', (e) => {
            if (e.target.classList.contains('kanban-cards') || e.target.closest('.kanban-cards')) {
                e.target.style.backgroundColor = '';
            }
        });

        document.addEventListener('drop', async (e) => {
            if (e.target.classList.contains('kanban-cards') || e.target.closest('.kanban-cards')) {
                e.preventDefault();
                const dropZone = e.target.classList.contains('kanban-cards') ? e.target : e.target.closest('.kanban-cards');
                dropZone.style.backgroundColor = '';

                if (draggedItem) {
                    const itemId = draggedItem.dataset.itemId;
                    const newStatus = dropZone.dataset.dropZone;

                    if (newStatus) {
                        const ok = await Actions.moveItemStatus(itemId, newStatus, this.data);
                        if (ok) {
                            Storage.showToast('Statut mis à jour', 'success');
                            this.data = Storage.loadData();
                            this.renderView('kanban');
                        }
                    }
                }
            }
        });

        // Calendrier navigation
        document.addEventListener('click', (e) => {
            if (e.target.id === 'calendar-prev' || e.target.closest('#calendar-prev')) {
                this.currentCalendarMonth--;
                if (this.currentCalendarMonth < 0) {
                    this.currentCalendarMonth = 11;
                    this.currentCalendarYear--;
                }
                this.renderView('calendar');
            } else if (e.target.id === 'calendar-next' || e.target.closest('#calendar-next')) {
                this.currentCalendarMonth++;
                if (this.currentCalendarMonth > 11) {
                    this.currentCalendarMonth = 0;
                    this.currentCalendarYear++;
                }
                this.renderView('calendar');
            }
        });

        // Clic sur événement calendrier
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('calendar-event')) {
                const itemId = e.target.dataset.itemId;
                if (itemId) {
                    const university = Selectors.getActiveUniversity(this.data);
                    const item = university ? university.items.find(i => i.id === itemId) : null;
                    if (item) {
                        Render.renderModalEdit(item, this.data);
                    }
                }
            }
        });
    }
};

// ============================================
// START APP
// ============================================

// Marquer que tout le fichier a été parsé
window._appJsFullyLoaded = true;
console.log('app.js: fichier entièrement chargé');

document.addEventListener('DOMContentLoaded', async () => {
    console.log('app.js: DOMContentLoaded, démarrage App.init()');
    try {
        await App.init();
        console.log('app.js: App.init() terminé avec succès');
        window._appReady = true;
    } catch (e) {
        console.error('app.js: Erreur dans App.init():', e);
        alert('Erreur initialisation app: ' + e.message);
    }
});
