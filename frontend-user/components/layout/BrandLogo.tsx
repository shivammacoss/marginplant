import { Sprout } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";

interface BrandLogoProps {
  href?: string | null;
  size?: "sm" | "md" | "lg";
  iconOnly?: boolean;
  className?: string;
}

export function BrandLogo({ href = "/dashboard", size = "md", iconOnly = false, className }: BrandLogoProps) {
  const sizes = {
    sm: { wrap: "text-sm", icon: "size-5", badge: "p-1" },
    md: { wrap: "text-lg", icon: "size-6", badge: "p-1.5" },
    lg: { wrap: "text-2xl", icon: "size-8", badge: "p-2" },
  }[size];

  const content = (
    <span className={cn("inline-flex items-center gap-2 font-semibold tracking-tight", sizes.wrap, className)}>
      <span className={cn("rounded-md bg-primary/15 text-primary", sizes.badge)}>
        <Sprout className={sizes.icon} strokeWidth={2.5} />
      </span>
      {!iconOnly && (
        <span>
          <span className="text-primary">MarginPlant</span>
          <span className="text-foreground"> Broker</span>
        </span>
      )}
    </span>
  );

  if (href) {
    return (
      <Link href={href} className="outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md">
        {content}
      </Link>
    );
  }
  return content;
}
