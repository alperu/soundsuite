'use client';

const CATEGORY_COLORS: Record<string, { bg: string; text: string }> = {
  search:        { bg: 'bg-blue-50',   text: 'text-blue-700' },
  contradiction: { bg: 'bg-red-50',    text: 'text-red-700' },
  argument:      { bg: 'bg-purple-50', text: 'text-purple-700' },
  timeline:      { bg: 'bg-amber-50',  text: 'text-amber-700' },
  entity:        { bg: 'bg-green-50',  text: 'text-green-700' },
  review:        { bg: 'bg-orange-50', text: 'text-orange-700' },
};

interface MCPCategoryBadgeProps {
  category: string;
}

export function MCPCategoryBadge({ category }: MCPCategoryBadgeProps) {
  const colors = CATEGORY_COLORS[category] || { bg: 'bg-gray-50', text: 'text-gray-700' };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors.bg} ${colors.text}`}>
      {category}
    </span>
  );
}
