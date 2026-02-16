'use client';

import TagEditor from './tag-editor';

interface TemplateEditorHeaderProps {
  name: string;
  description: string;
  jurisdiction: string;
  category: string;
  tags: string[];
  allTags: string[];
  categories: string[];
  onNameChange: (v: string) => void;
  onDescriptionChange: (v: string) => void;
  onJurisdictionChange: (v: string) => void;
  onCategoryChange: (v: string) => void;
  onTagsChange: (tags: string[]) => void;
  onSave: () => void;
  onDelete: () => void;
  saving: boolean;
  saveStatus: 'saved' | 'unsaved' | 'saving' | '';
}

export default function TemplateEditorHeader({
  name, description, jurisdiction, category, tags,
  allTags, categories,
  onNameChange, onDescriptionChange, onJurisdictionChange, onCategoryChange, onTagsChange,
  onSave, onDelete, saving, saveStatus,
}: TemplateEditorHeaderProps) {
  return (
    <div className="flex-shrink-0 bg-white border-b border-gray-200 px-6 py-3 space-y-2">
      {/* Top row: badge + name + actions */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-purple-100 text-purple-700 flex-shrink-0">
            Template
          </span>
          <input
            value={name}
            onChange={e => onNameChange(e.target.value)}
            placeholder="Template name"
            className="flex-1 min-w-0 text-lg font-semibold text-gray-900 bg-transparent border-b border-transparent hover:border-gray-300 focus:border-purple-500 focus:outline-none px-1 py-0.5"
          />
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {saveStatus === 'saved' && <span className="text-xs text-green-600">Saved</span>}
          {saveStatus === 'unsaved' && <span className="text-xs text-amber-600">Unsaved changes</span>}
          {saveStatus === 'saving' && <span className="text-xs text-blue-600">Saving...</span>}
          <button
            onClick={onSave}
            disabled={saving || saveStatus === 'saved'}
            className="px-3 py-1.5 bg-purple-600 text-white rounded-md text-sm font-medium hover:bg-purple-700 disabled:bg-gray-300 disabled:text-gray-500"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          <span className="text-xs text-gray-400" title="Keyboard shortcut">Ctrl+S</span>
          <button
            onClick={onDelete}
            className="px-3 py-1.5 text-red-600 hover:bg-red-50 rounded-md text-sm"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Second row: metadata fields */}
      <div className="flex items-center gap-3 text-xs">
        <div className="flex items-center gap-1">
          <label className="text-gray-500 font-medium">Description:</label>
          <input
            value={description}
            onChange={e => onDescriptionChange(e.target.value)}
            placeholder="Brief description"
            className="px-1.5 py-0.5 border border-gray-200 rounded text-xs w-48 focus:ring-1 focus:ring-purple-500 focus:border-purple-500"
          />
        </div>
        <div className="flex items-center gap-1">
          <label className="text-gray-500 font-medium">Jurisdiction:</label>
          <input
            value={jurisdiction}
            onChange={e => onJurisdictionChange(e.target.value)}
            placeholder="e.g. Federal"
            className="px-1.5 py-0.5 border border-gray-200 rounded text-xs w-24 focus:ring-1 focus:ring-purple-500 focus:border-purple-500"
          />
        </div>
        <div className="flex items-center gap-1">
          <label className="text-gray-500 font-medium">Category:</label>
          <input
            list="template-categories"
            value={category}
            onChange={e => onCategoryChange(e.target.value)}
            placeholder="e.g. Motions"
            className="px-1.5 py-0.5 border border-gray-200 rounded text-xs w-28 focus:ring-1 focus:ring-purple-500 focus:border-purple-500"
          />
          <datalist id="template-categories">
            {categories.map(c => <option key={c} value={c} />)}
          </datalist>
        </div>
        <div className="flex items-center gap-1 flex-1 min-w-0">
          <label className="text-gray-500 font-medium flex-shrink-0">Tags:</label>
          <div className="flex-1 min-w-0">
            <TagEditor tags={tags} onChange={onTagsChange} suggestions={allTags} />
          </div>
        </div>
      </div>
    </div>
  );
}
