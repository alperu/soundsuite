'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import TemplateEditorHeader from '@/components/workflow/template-editor-header';
import { getPreference, setPreference } from '@/lib/indexed-db';

const MilkdownEditor = dynamic(() => import('@/components/milkdown-editor'), {
  ssr: false,
  loading: () => <div className="p-8 text-gray-400 text-sm">Loading editor...</div>,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WorkflowTemplate {
  id: string;
  name: string;
  jurisdiction?: string;
  category?: string;
  tags: string[];
  description?: string;
  content: string;
}

interface Workflow {
  id: string;
  caseId: string;
  title: string;
  slug: string;
  content: string;
  status: string;
  templateId?: string;
  template?: { name: string };
  createdAt: string;
}

interface Case {
  id: string;
  name: string;
  caseNumber?: string;
}

// ---------------------------------------------------------------------------
// Sizing defaults & preference keys
// ---------------------------------------------------------------------------

const SIDEBAR_MIN = 240;
const SIDEBAR_MAX = 600;
const SIDEBAR_DEFAULT = 320;
const SPLIT_DEFAULT = 65; // workflows get 65%, templates 35%
const SPLIT_MIN = 20;
const SPLIT_MAX = 80;

const PREF_SIDEBAR_WIDTH = 'workflow.sidebarWidth';
const prefSplitKey = (caseId: string) =>
  caseId ? `workflow.split.${caseId}` : 'workflow.split._global';

const PREF_LAST_STATE = 'workflow.lastState';

interface WorkflowLastState {
  caseId: string;
  editingMode: 'workflow' | 'template' | null;
  workflowId: string | null;
  workflowSlug: string | null;
  templateId: string | null;
  templateSearch: string;
  selectedCategory: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function WorkflowPage() {
  const router = useRouter();
  const params = useParams<{ path?: string[] }>();
  const searchParams = useSearchParams();

  // URL path segments: /workflow/[caseId]/[slug] or /workflow/template/[templateId]
  const urlCaseId = params.path?.[0] || '';
  const urlSlug = params.path?.[1] || '';
  const urlTemplateId = urlCaseId === 'template' ? urlSlug : '';

  // Read ?template= query param for pre-selecting a template
  const templateParam = searchParams.get('template');

  // State
  const [cases, setCases] = useState<Case[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState(urlTemplateId ? '' : urlCaseId);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [activeWorkflow, setActiveWorkflow] = useState<Workflow | null>(null);
  const [activeTemplate, setActiveTemplate] = useState<WorkflowTemplate | null>(null);
  const [editingMode, setEditingMode] = useState<'workflow' | 'template' | null>(null);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'saved' | 'unsaved' | 'saving' | ''>('');
  const [loading, setLoading] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);

  // Template creation form
  const [showCreateTemplateForm, setShowCreateTemplateForm] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState('');
  const [newTemplateCategory, setNewTemplateCategory] = useState('');

  // Template search & filtering
  const [templateSearch, setTemplateSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');

  // Workflow editing metadata
  const [editWorkflowTitle, setEditWorkflowTitle] = useState('');

  // Template editing metadata
  const [editTemplateName, setEditTemplateName] = useState('');
  const [editTemplateDescription, setEditTemplateDescription] = useState('');
  const [editTemplateJurisdiction, setEditTemplateJurisdiction] = useState('');
  const [editTemplateCategory, setEditTemplateCategory] = useState('');
  const [editTemplateTags, setEditTemplateTags] = useState<string[]>([]);

  // All tags for autocomplete
  const [allTags, setAllTags] = useState<string[]>([]);

  // Track if content has been modified since last save
  const savedContentRef = useRef('');
  const urlTemplateLoaded = useRef(false);

  // Session restore tracking
  const pendingRestore = useRef<WorkflowLastState | null>(null);
  const isRestoring = useRef(!urlCaseId && !urlTemplateId);

  // ---- Resizable panels state ----
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const [workflowSplit, setWorkflowSplit] = useState(SPLIT_DEFAULT); // % for workflows
  const isResizingSidebar = useRef(false);
  const isResizingSplit = useRef(false);
  const sidebarRef = useRef<HTMLDivElement>(null);

  // Load persisted sidebar width
  useEffect(() => {
    getPreference<number>(PREF_SIDEBAR_WIDTH).then(v => {
      if (v && v >= SIDEBAR_MIN && v <= SIDEBAR_MAX) setSidebarWidth(v);
    }).catch(() => {});
  }, []);

  // Load persisted split for current case
  useEffect(() => {
    const key = prefSplitKey(selectedCaseId);
    getPreference<number>(key).then(v => {
      if (v && v >= SPLIT_MIN && v <= SPLIT_MAX) setWorkflowSplit(v);
      else setWorkflowSplit(SPLIT_DEFAULT);
    }).catch(() => setWorkflowSplit(SPLIT_DEFAULT));
  }, [selectedCaseId]);

  // Restore last session state from IndexedDB (only when URL is bare /workflow)
  useEffect(() => {
    if (!isRestoring.current) return;

    getPreference<WorkflowLastState>(PREF_LAST_STATE).then(state => {
      if (!state) {
        isRestoring.current = false;
        return;
      }

      if (state.templateSearch) setTemplateSearch(state.templateSearch);
      if (state.selectedCategory) setSelectedCategory(state.selectedCategory);

      if (state.caseId) {
        setSelectedCaseId(state.caseId);
      }

      if (state.editingMode && (state.workflowId || state.templateId)) {
        pendingRestore.current = state;
      } else if (state.caseId) {
        // Case only (no active editor) — update URL
        router.replace(`/workflow/${state.caseId}`, { scroll: false });
      }

      isRestoring.current = false;
    }).catch(() => {
      isRestoring.current = false;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Horizontal resize (sidebar width) ----
  const handleSidebarResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingSidebar.current = true;
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizingSidebar.current) return;
      const newWidth = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startWidth + ev.clientX - startX));
      setSidebarWidth(newWidth);
    };
    const onMouseUp = () => {
      isResizingSidebar.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setSidebarWidth(prev => {
        setPreference(PREF_SIDEBAR_WIDTH, prev).catch(() => {});
        return prev;
      });
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [sidebarWidth]);

  // ---- Vertical resize (workflow/template split) ----
  const handleSplitResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingSplit.current = true;
    const startY = e.clientY;
    const startSplit = workflowSplit;
    const container = sidebarRef.current;
    if (!container) return;

    // Measure the available height (below case selector)
    const caseSelector = container.firstElementChild as HTMLElement;
    const caseSelectorH = caseSelector ? caseSelector.offsetHeight : 0;
    const availableH = container.offsetHeight - caseSelectorH;

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizingSplit.current || availableH <= 0) return;
      const deltaPercent = ((ev.clientY - startY) / availableH) * 100;
      const newSplit = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, startSplit + deltaPercent));
      setWorkflowSplit(newSplit);
    };
    const onMouseUp = () => {
      isResizingSplit.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setWorkflowSplit(prev => {
        const key = prefSplitKey(selectedCaseId);
        setPreference(key, prev).catch(() => {});
        return prev;
      });
    };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [workflowSplit, selectedCaseId]);

  // Derive categories from templates
  const categories = useMemo(() =>
    [...new Set(templates.map(t => t.category).filter((c): c is string => !!c))].sort(),
    [templates]
  );

  // Filter templates based on search and category
  const filteredTemplates = useMemo(() => {
    return templates.filter(t => {
      if (selectedCategory && t.category !== selectedCategory) return false;
      if (templateSearch) {
        const q = templateSearch.toLowerCase();
        return (
          t.name.toLowerCase().includes(q) ||
          t.description?.toLowerCase().includes(q) ||
          t.tags.some(tag => tag.includes(q))
        );
      }
      return true;
    });
  }, [templates, selectedCategory, templateSearch]);

  // Load cases
  useEffect(() => {
    fetch('/api/cases')
      .then(r => r.json())
      .then(data => setCases(data.cases || []))
      .catch(() => {});
  }, []);

  // Load templates
  useEffect(() => {
    fetch('/api/workflow-templates')
      .then(r => r.json())
      .then(data => {
        const tmpl = data.templates || [];
        setTemplates(tmpl);

        // If ?template= param, pre-select the matching template and open create form
        if (templateParam) {
          const slug = templateParam.toLowerCase();
          const match = tmpl.find((t: WorkflowTemplate) =>
            t.tags.some((tag: string) => tag === slug) ||
            t.name.toLowerCase().replace(/\s+/g, '-') === slug
          );
          if (match) {
            setSelectedTemplateId(match.id);
            setShowCreateForm(true);
            setNewTitle(match.name);
          }
        }
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-load template from URL or saved state
  useEffect(() => {
    if (templates.length === 0) return;

    // URL template loading
    if (urlTemplateId && !urlTemplateLoaded.current) {
      const match = templates.find(t => t.id === urlTemplateId);
      if (match) {
        urlTemplateLoaded.current = true;
        setActiveTemplate(match);
        setActiveWorkflow(null);
        setEditingMode('template');
        setEditContent(match.content);
        savedContentRef.current = match.content;
        setEditTemplateName(match.name);
        setEditTemplateDescription(match.description || '');
        setEditTemplateJurisdiction(match.jurisdiction || '');
        setEditTemplateCategory(match.category || '');
        setEditTemplateTags(match.tags || []);
        setSaveStatus('saved');
      }
      return;
    }

    // Restore from saved state
    const pending = pendingRestore.current;
    if (pending?.editingMode === 'template' && pending.templateId) {
      const match = templates.find(t => t.id === pending.templateId);
      if (match) {
        pendingRestore.current = null;
        loadTemplate(match);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates]);

  // Load all tags for autocomplete
  useEffect(() => {
    fetch('/api/workflow-templates/tags')
      .then(r => r.json())
      .then(data => setAllTags(data.tags || []))
      .catch(() => {});
  }, []);

  // Load workflows when case changes
  useEffect(() => {
    if (!selectedCaseId) {
      setWorkflows([]);
      setActiveWorkflow(null);
      return;
    }
    setLoading(true);
    fetch(`/api/workflows?caseId=${selectedCaseId}`)
      .then(r => r.json())
      .then(data => {
        const wfs = data.workflows || [];
        setWorkflows(wfs);

        // If URL has a slug, auto-load that workflow
        if (urlSlug && urlCaseId === selectedCaseId) {
          const match = wfs.find((w: Workflow) => w.slug === urlSlug);
          if (match) {
            loadWorkflowById(match.id);
            return;
          }
        }

        // Restore from saved state
        const pending = pendingRestore.current;
        if (pending?.editingMode === 'workflow' && pending.workflowId) {
          const match = wfs.find((w: Workflow) => w.id === pending.workflowId);
          if (match) {
            pendingRestore.current = null;
            loadWorkflowById(match.id);
          }
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCaseId]);

  // Update URL when active workflow changes
  const updateUrl = useCallback((caseId: string, slug: string, templateId?: string) => {
    const newPath = templateId
      ? `/workflow/template/${templateId}`
      : slug
        ? `/workflow/${caseId}/${slug}`
        : caseId
          ? `/workflow/${caseId}`
          : '/workflow';
    router.replace(newPath, { scroll: false });
  }, [router]);

  // Check for unsaved changes before switching
  const hasUnsavedChanges = useCallback(() => {
    return saveStatus === 'unsaved';
  }, [saveStatus]);

  const confirmSwitch = useCallback(() => {
    if (hasUnsavedChanges()) {
      return window.confirm('You have unsaved changes. Discard and switch?');
    }
    return true;
  }, [hasUnsavedChanges]);

  // Load workflow content by ID
  const loadWorkflowById = useCallback(async (id: string) => {
    if (!confirmSwitch()) return;
    try {
      const res = await fetch(`/api/workflows/${id}`);
      const data = await res.json();
      if (data.workflow) {
        setActiveWorkflow(data.workflow);
        setActiveTemplate(null);
        setEditingMode('workflow');
        setEditContent(data.workflow.content);
        setEditWorkflowTitle(data.workflow.title);
        savedContentRef.current = data.workflow.content;
        setSaveStatus('saved');
        updateUrl(data.workflow.caseId, data.workflow.slug);
      }
    } catch { /* ignore */ }
  }, [updateUrl, confirmSwitch]);

  // Load template into editor
  const loadTemplate = useCallback((template: WorkflowTemplate) => {
    if (!confirmSwitch()) return;
    setActiveTemplate(template);
    setActiveWorkflow(null);
    setEditingMode('template');
    setEditContent(template.content);
    savedContentRef.current = template.content;
    setEditTemplateName(template.name);
    setEditTemplateDescription(template.description || '');
    setEditTemplateJurisdiction(template.jurisdiction || '');
    setEditTemplateCategory(template.category || '');
    setEditTemplateTags(template.tags || []);
    setSaveStatus('saved');
    updateUrl('', '', template.id);
  }, [confirmSwitch, updateUrl]);

  // Handle case selection
  const handleCaseChange = useCallback((caseId: string) => {
    setSelectedCaseId(caseId);
    setActiveWorkflow(null);
    // Don't clear template editing when switching cases
    if (editingMode === 'workflow') {
      setEditingMode(null);
      setSaveStatus('');
    }
    // Don't override template URL when in template editing mode
    if (editingMode !== 'template') {
      if (caseId) {
        updateUrl(caseId, '');
      } else {
        updateUrl('', '');
      }
    }
  }, [updateUrl, editingMode]);

  // Handle markdown content changes
  const handleContentChange = useCallback((markdown: string) => {
    setEditContent(markdown);
    if (markdown !== savedContentRef.current) {
      setSaveStatus('unsaved');
    }
  }, []);

  // Detect template metadata changes
  const handleTemplateMetaChange = useCallback(() => {
    setSaveStatus('unsaved');
  }, []);

  // Create workflow
  const handleCreate = async () => {
    if (!selectedCaseId || !newTitle.trim()) return;
    try {
      const res = await fetch('/api/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseId: selectedCaseId,
          title: newTitle.trim(),
          templateId: selectedTemplateId || undefined,
        }),
      });
      const data = await res.json();
      if (data.workflow) {
        setWorkflows(prev => [data.workflow, ...prev]);
        setActiveWorkflow(data.workflow);
        setActiveTemplate(null);
        setEditingMode('workflow');
        setEditContent(data.workflow.content);
        setEditWorkflowTitle(data.workflow.title);
        savedContentRef.current = data.workflow.content;
        setSaveStatus('saved');
        setShowCreateForm(false);
        setNewTitle('');
        setSelectedTemplateId('');
        updateUrl(data.workflow.caseId, data.workflow.slug);
      }
    } catch { /* ignore */ }
  };

  // Save workflow
  const handleSaveWorkflow = useCallback(async () => {
    if (!activeWorkflow) return;
    setSaving(true);
    setSaveStatus('saving');
    try {
      const res = await fetch(`/api/workflows/${activeWorkflow.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: editWorkflowTitle, content: editContent }),
      });
      const data = await res.json();
      if (data.workflow) {
        setActiveWorkflow(data.workflow);
        savedContentRef.current = data.workflow.content;
        // Update sidebar list with new title
        setWorkflows(prev => prev.map(w => w.id === data.workflow.id ? { ...w, title: data.workflow.title } : w));
        setSaveStatus('saved');
      }
    } catch {
      setSaveStatus('unsaved');
    } finally {
      setSaving(false);
    }
  }, [activeWorkflow, editContent, editWorkflowTitle]);

  // Save template
  const handleSaveTemplate = useCallback(async () => {
    if (!activeTemplate) return;
    setSaving(true);
    setSaveStatus('saving');
    try {
      const res = await fetch(`/api/workflow-templates/${activeTemplate.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editTemplateName,
          description: editTemplateDescription || undefined,
          jurisdiction: editTemplateJurisdiction || undefined,
          category: editTemplateCategory || undefined,
          tags: editTemplateTags,
          content: editContent,
        }),
      });
      const data = await res.json();
      if (data.template) {
        const updated: WorkflowTemplate = {
          id: data.template.id,
          name: data.template.name,
          jurisdiction: data.template.jurisdiction,
          category: data.template.category,
          tags: Array.isArray(data.template.tags)
            ? data.template.tags
            : typeof data.template.tags === 'string'
              ? JSON.parse(data.template.tags)
              : [],
          description: data.template.description,
          content: data.template.content,
        };
        setActiveTemplate(updated);
        savedContentRef.current = updated.content;
        // Update sidebar list
        setTemplates(prev => prev.map(t => t.id === updated.id ? updated : t));
        // Update allTags with any new tags
        setAllTags(prev => {
          const combined = new Set([...prev, ...updated.tags]);
          return [...combined].sort();
        });
        setSaveStatus('saved');
      }
    } catch {
      setSaveStatus('unsaved');
    } finally {
      setSaving(false);
    }
  }, [activeTemplate, editContent, editTemplateName, editTemplateDescription, editTemplateJurisdiction, editTemplateCategory, editTemplateTags]);

  // Combined save handler
  const handleSave = useCallback(() => {
    if (editingMode === 'workflow') handleSaveWorkflow();
    else if (editingMode === 'template') handleSaveTemplate();
  }, [editingMode, handleSaveWorkflow, handleSaveTemplate]);

  // Ctrl+S keyboard shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSave]);

  // Persist session state to IndexedDB
  useEffect(() => {
    if (isRestoring.current) return;
    const state: WorkflowLastState = {
      caseId: selectedCaseId,
      editingMode: editingMode,
      workflowId: activeWorkflow?.id || null,
      workflowSlug: activeWorkflow?.slug || null,
      templateId: activeTemplate?.id || null,
      templateSearch,
      selectedCategory,
    };
    setPreference(PREF_LAST_STATE, state).catch(() => {});
  }, [selectedCaseId, editingMode, activeWorkflow?.id, activeWorkflow?.slug, activeTemplate?.id, templateSearch, selectedCategory]);

  // Delete workflow
  const handleDeleteWorkflow = async (id: string) => {
    try {
      await fetch(`/api/workflows/${id}`, { method: 'DELETE' });
      setWorkflows(prev => prev.filter(w => w.id !== id));
      if (activeWorkflow?.id === id) {
        setActiveWorkflow(null);
        setEditingMode(null);
        setSaveStatus('');
        updateUrl(selectedCaseId, '');
      }
    } catch { /* ignore */ }
  };

  // Create template
  const handleCreateTemplate = async () => {
    if (!newTemplateName.trim()) return;
    try {
      const res = await fetch('/api/workflow-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newTemplateName.trim(),
          category: newTemplateCategory || undefined,
          content: '',
        }),
      });
      const data = await res.json();
      if (data.template) {
        const created: WorkflowTemplate = {
          id: data.template.id,
          name: data.template.name,
          jurisdiction: data.template.jurisdiction,
          category: data.template.category,
          tags: Array.isArray(data.template.tags)
            ? data.template.tags
            : typeof data.template.tags === 'string'
              ? JSON.parse(data.template.tags)
              : [],
          description: data.template.description,
          content: data.template.content ?? '',
        };
        setTemplates(prev => [created, ...prev]);
        setShowCreateTemplateForm(false);
        setNewTemplateName('');
        setNewTemplateCategory('');
        // Open it in the editor immediately
        loadTemplate(created);
      }
    } catch { /* ignore */ }
  };

  // Delete template
  const handleDeleteTemplate = async (id: string) => {
    if (!window.confirm('Delete this template? Existing workflows using it will not be affected.')) return;
    try {
      await fetch(`/api/workflow-templates/${id}`, { method: 'DELETE' });
      setTemplates(prev => prev.filter(t => t.id !== id));
      if (activeTemplate?.id === id) {
        setActiveTemplate(null);
        setEditingMode(null);
        setSaveStatus('');
        updateUrl(selectedCaseId, '');
      }
    } catch { /* ignore */ }
  };

  return (
    <div className="flex h-full">
      {/* ---- Left Panel: Workflows & Templates ---- */}
      <aside
        ref={sidebarRef}
        style={{ width: sidebarWidth }}
        className="flex-shrink-0 border-r border-gray-200 bg-white flex flex-col overflow-hidden"
      >
        {/* Case selector */}
        <div className="p-3 border-b border-gray-200 flex-shrink-0">
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Case</label>
          <select
            value={selectedCaseId}
            onChange={e => handleCaseChange(e.target.value)}
            className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm bg-white"
          >
            <option value="">Select a case...</option>
            {cases.map(c => (
              <option key={c.id} value={c.id}>
                {c.caseNumber ? `${c.caseNumber} — ${c.name}` : c.name}
              </option>
            ))}
          </select>
        </div>

        {/* Workflows section — takes workflowSplit% */}
        <div
          className="overflow-y-auto p-3 flex-shrink-0"
          style={{ height: `${workflowSplit}%` }}
        >
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Workflows</h3>
            {selectedCaseId && (
              <button
                onClick={() => setShowCreateForm(!showCreateForm)}
                className="text-xs text-blue-600 hover:text-blue-800 font-medium"
              >
                + New
              </button>
            )}
          </div>

          {/* Create form */}
          {showCreateForm && selectedCaseId && (
            <div className="mb-3 p-2 bg-blue-50 rounded-md border border-blue-200 space-y-2">
              <input
                value={newTitle}
                onChange={e => setNewTitle(e.target.value)}
                placeholder="Workflow title..."
                className="w-full px-2 py-1 border border-gray-300 rounded text-xs"
              />
              <select
                value={selectedTemplateId}
                onChange={e => setSelectedTemplateId(e.target.value)}
                className="w-full px-2 py-1 border border-gray-300 rounded text-xs bg-white"
              >
                <option value="">Blank workflow</option>
                {categories.length > 0
                  ? categories.map(cat => (
                      <optgroup key={cat} label={cat}>
                        {templates.filter(t => t.category === cat).map(t => (
                          <option key={t.id} value={t.id}>{t.name}</option>
                        ))}
                      </optgroup>
                    ))
                  : templates.map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))
                }
                {templates.filter(t => !t.category).length > 0 && categories.length > 0 && (
                  <optgroup label="Other">
                    {templates.filter(t => !t.category).map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </optgroup>
                )}
              </select>
              <div className="flex gap-1">
                <button
                  onClick={handleCreate}
                  disabled={!newTitle.trim()}
                  className="flex-1 px-2 py-1 bg-blue-600 text-white rounded text-xs font-medium hover:bg-blue-700 disabled:bg-gray-300"
                >
                  Create
                </button>
                <button
                  onClick={() => setShowCreateForm(false)}
                  className="px-2 py-1 bg-gray-200 text-gray-700 rounded text-xs"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {!selectedCaseId && (
            <p className="text-xs text-gray-400 text-center py-4">Select a case to view workflows</p>
          )}

          {loading && <p className="text-xs text-gray-400 text-center py-4">Loading...</p>}

          {!loading && selectedCaseId && workflows.length === 0 && (
            <p className="text-xs text-gray-400 text-center py-4">No workflows yet. Create one to get started.</p>
          )}

          <div className="space-y-1">
            {workflows.map(w => (
              <div
                key={w.id}
                className={`group relative w-full text-left px-2.5 py-2 rounded-md text-sm transition-colors cursor-pointer ${
                  activeWorkflow?.id === w.id
                    ? 'bg-blue-50 text-blue-700 border border-blue-200'
                    : 'text-gray-700 hover:bg-gray-50'
                }`}
                onClick={() => loadWorkflowById(w.id)}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-xs truncate">{w.title}</span>
                  <div className="flex items-center gap-1">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                      w.status === 'draft' ? 'bg-gray-100 text-gray-500' : 'bg-green-100 text-green-700'
                    }`}>
                      {w.status}
                    </span>
                    <button
                      onClick={e => { e.stopPropagation(); handleDeleteWorkflow(w.id); }}
                      className="hidden group-hover:inline-flex items-center justify-center w-5 h-5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50"
                      title="Delete workflow"
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                </div>
                {w.template && (
                  <p className="text-[10px] text-gray-400 mt-0.5">From: {w.template.name}</p>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* ---- Vertical drag handle (workflow/template split) ---- */}
        <div
          onMouseDown={handleSplitResizeStart}
          className="h-1 flex-shrink-0 cursor-row-resize hover:bg-blue-400 active:bg-blue-500 bg-gray-200 transition-colors"
        />

        {/* Templates section — takes remaining space */}
        <div
          className="overflow-y-auto p-3 flex-1 min-h-0"
        >
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Templates</h3>
            <button
              onClick={() => setShowCreateTemplateForm(!showCreateTemplateForm)}
              className="text-xs text-purple-600 hover:text-purple-800 font-medium"
            >
              + New
            </button>
          </div>

          {/* Create template form */}
          {showCreateTemplateForm && (
            <div className="mb-3 p-2 bg-purple-50 rounded-md border border-purple-200 space-y-2">
              <input
                value={newTemplateName}
                onChange={e => setNewTemplateName(e.target.value)}
                placeholder="Template name..."
                className="w-full px-2 py-1 border border-gray-300 rounded text-xs"
                autoFocus
                onKeyDown={e => { if (e.key === 'Enter') handleCreateTemplate(); }}
              />
              <input
                list="new-template-categories"
                value={newTemplateCategory}
                onChange={e => setNewTemplateCategory(e.target.value)}
                placeholder="Category (optional)"
                className="w-full px-2 py-1 border border-gray-300 rounded text-xs"
              />
              <datalist id="new-template-categories">
                {categories.map(c => <option key={c} value={c} />)}
              </datalist>
              <div className="flex gap-1">
                <button
                  onClick={handleCreateTemplate}
                  disabled={!newTemplateName.trim()}
                  className="flex-1 px-2 py-1 bg-purple-600 text-white rounded text-xs font-medium hover:bg-purple-700 disabled:bg-gray-300"
                >
                  Create
                </button>
                <button
                  onClick={() => { setShowCreateTemplateForm(false); setNewTemplateName(''); setNewTemplateCategory(''); }}
                  className="px-2 py-1 bg-gray-200 text-gray-700 rounded text-xs"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Search */}
          <input
            type="text"
            value={templateSearch}
            onChange={e => setTemplateSearch(e.target.value)}
            placeholder="Search templates..."
            className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-xs mb-2 focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
          />

          {/* Category pills */}
          {categories.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              <button
                onClick={() => setSelectedCategory('')}
                className={`px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors ${
                  !selectedCategory
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                All
              </button>
              {categories.map(cat => (
                <button
                  key={cat}
                  onClick={() => setSelectedCategory(selectedCategory === cat ? '' : cat)}
                  className={`px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors ${
                    selectedCategory === cat
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          )}

          {/* Template list */}
          {filteredTemplates.length === 0 ? (
            <p className="text-xs text-gray-400">
              {templateSearch || selectedCategory ? 'No matching templates' : 'No templates available'}
            </p>
          ) : (
            <div className="space-y-1">
              {filteredTemplates.map(t => (
                <button
                  key={t.id}
                  onClick={() => loadTemplate(t)}
                  className={`w-full text-left px-2 py-1.5 rounded-md text-xs transition-colors ${
                    activeTemplate?.id === t.id
                      ? 'bg-purple-50 border border-purple-300 ring-1 ring-purple-200'
                      : 'bg-gray-50 hover:bg-gray-100'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className={`font-medium ${activeTemplate?.id === t.id ? 'text-purple-700' : 'text-gray-700'}`}>
                      {t.name}
                    </span>
                    {t.jurisdiction && <span className="text-gray-400 text-[10px]">({t.jurisdiction})</span>}
                  </div>
                  {t.tags.length > 0 && (
                    <div className="flex flex-wrap gap-0.5 mt-1">
                      {t.tags.slice(0, 3).map(tag => (
                        <span
                          key={tag}
                          className="inline-block px-1.5 py-0 rounded bg-blue-50 text-blue-600 text-[9px] font-medium"
                        >
                          {tag}
                        </span>
                      ))}
                      {t.tags.length > 3 && (
                        <span className="text-[9px] text-gray-400">+{t.tags.length - 3}</span>
                      )}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>

      {/* ---- Horizontal drag handle (sidebar width) ---- */}
      <div
        onMouseDown={handleSidebarResizeStart}
        className="w-1 flex-shrink-0 cursor-col-resize hover:bg-blue-400 active:bg-blue-500 transition-colors"
      />

      {/* ---- Center: Milkdown Editor ---- */}
      <div className="flex-1 min-w-0 flex flex-col bg-gray-50">
        {editingMode === 'workflow' && activeWorkflow ? (
          <>
            {/* Workflow Toolbar */}
            <div className="flex-shrink-0 bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
              <div className="min-w-0 flex-1 mr-4">
                <input
                  value={editWorkflowTitle}
                  onChange={e => { setEditWorkflowTitle(e.target.value); setSaveStatus('unsaved'); }}
                  className="text-lg font-semibold text-gray-900 bg-transparent border-b border-transparent hover:border-gray-300 focus:border-blue-500 focus:outline-none w-full px-1 py-0.5"
                />
                <p className="text-xs text-gray-400">
                  {activeWorkflow.template ? `Template: ${activeWorkflow.template.name}` : 'Custom workflow'}
                  {' '}&middot; Status: {activeWorkflow.status}
                  {activeWorkflow.slug && (
                    <span className="ml-2 text-gray-300">/{activeWorkflow.slug}</span>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {saveStatus === 'saved' && <span className="text-xs text-green-600">Saved</span>}
                {saveStatus === 'unsaved' && <span className="text-xs text-amber-600">Unsaved changes</span>}
                {saveStatus === 'saving' && <span className="text-xs text-blue-600">Saving...</span>}
                <button
                  onClick={handleSaveWorkflow}
                  disabled={saving || saveStatus === 'saved'}
                  className="px-3 py-1.5 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:bg-gray-300 disabled:text-gray-500"
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
                <span className="text-xs text-gray-400" title="Keyboard shortcut">Ctrl+S</span>
                <button
                  onClick={() => handleDeleteWorkflow(activeWorkflow.id)}
                  className="px-3 py-1.5 text-red-600 hover:bg-red-50 rounded-md text-sm"
                >
                  Delete
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-hidden">
              <MilkdownEditor
                key={activeWorkflow.id}
                value={editContent}
                onChange={handleContentChange}
              />
            </div>
          </>
        ) : editingMode === 'template' && activeTemplate ? (
          <>
            {/* Template Editor Header */}
            <TemplateEditorHeader
              name={editTemplateName}
              description={editTemplateDescription}
              jurisdiction={editTemplateJurisdiction}
              category={editTemplateCategory}
              tags={editTemplateTags}
              allTags={allTags}
              categories={categories}
              onNameChange={v => { setEditTemplateName(v); handleTemplateMetaChange(); }}
              onDescriptionChange={v => { setEditTemplateDescription(v); handleTemplateMetaChange(); }}
              onJurisdictionChange={v => { setEditTemplateJurisdiction(v); handleTemplateMetaChange(); }}
              onCategoryChange={v => { setEditTemplateCategory(v); handleTemplateMetaChange(); }}
              onTagsChange={tags => { setEditTemplateTags(tags); handleTemplateMetaChange(); }}
              onSave={handleSaveTemplate}
              onDelete={() => handleDeleteTemplate(activeTemplate.id)}
              saving={saving}
              saveStatus={saveStatus}
            />

            <div className="flex-1 overflow-hidden">
              <MilkdownEditor
                key={activeTemplate.id}
                value={editContent}
                onChange={handleContentChange}
              />
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <svg className="w-16 h-16 text-gray-200 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={0.75}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
              </svg>
              <h3 className="text-lg font-medium text-gray-400 mb-1">Workflow Library</h3>
              <p className="text-sm text-gray-400">
                {selectedCaseId
                  ? 'Select a workflow or template from the sidebar'
                  : 'Select a case to get started, or click a template to edit it'}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
