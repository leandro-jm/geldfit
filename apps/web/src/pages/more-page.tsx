import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { NAV, NAV_EXTRA } from '@/components/layout/nav';
import { PageHeader } from '@/components/common/states';

export function MorePage() {
  const items = [...NAV.filter((n) => !['/', '/projecao', '/lancamentos'].includes(n.to)), ...NAV_EXTRA];
  return (
    <div>
      <PageHeader title="Mais" />
      <Card className="divide-y overflow-hidden">
        {items.map((i) => (
          <Link
            key={i.to}
            to={i.to}
            className="flex min-h-14 items-center gap-3 px-4 text-[15px] font-medium active:bg-muted"
          >
            <span className="flex size-9 items-center justify-center rounded-xl bg-muted">
              <i.icon className="size-[18px] text-muted-foreground" aria-hidden />
            </span>
            <span className="flex-1">{i.label}</span>
            <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
          </Link>
        ))}
      </Card>
    </div>
  );
}
