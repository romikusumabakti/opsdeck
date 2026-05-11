"use client";

import { BookOpen } from "lucide-react";
import { useTranslations } from "next-intl";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

export function ApiDocsSheet({ content }: { content: string }) {
  const t = useTranslations("mockTime.docs");

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm">
          <BookOpen className="size-4" />
          {t("button")}
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader className="border-b">
          <SheetTitle>{t("title")}</SheetTitle>
          <SheetDescription>{t("description")}</SheetDescription>
        </SheetHeader>
        <article className="px-4 pb-6">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              h1: (props) => (
                <h1
                  className="text-xl font-semibold mt-6 mb-3 first:mt-0"
                  {...props}
                />
              ),
              h2: (props) => (
                <h2 className="text-lg font-semibold mt-6 mb-2" {...props} />
              ),
              h3: (props) => (
                <h3
                  className="text-sm font-semibold mt-4 mb-2 font-mono"
                  {...props}
                />
              ),
              p: (props) => (
                <p
                  className="text-sm leading-relaxed my-2 text-foreground/90"
                  {...props}
                />
              ),
              ul: (props) => (
                <ul
                  className="list-disc pl-5 my-2 text-sm space-y-1 text-foreground/90"
                  {...props}
                />
              ),
              ol: (props) => (
                <ol
                  className="list-decimal pl-5 my-2 text-sm space-y-1 text-foreground/90"
                  {...props}
                />
              ),
              code: ({ className, children, ...props }) => {
                const isBlock = className?.startsWith("language-");
                if (isBlock) {
                  return (
                    <code className={className} {...props}>
                      {children}
                    </code>
                  );
                }
                return (
                  <code
                    className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono"
                    {...props}
                  >
                    {children}
                  </code>
                );
              },
              pre: (props) => (
                <pre
                  className="my-3 rounded-md border bg-muted/50 p-3 overflow-x-auto text-xs font-mono leading-relaxed"
                  {...props}
                />
              ),
              table: (props) => (
                <div className="my-3 overflow-x-auto rounded-md border">
                  <table
                    className="w-full text-sm border-collapse"
                    {...props}
                  />
                </div>
              ),
              thead: (props) => (
                <thead className="bg-muted/50 border-b" {...props} />
              ),
              tr: (props) => (
                <tr className="border-b last:border-0" {...props} />
              ),
              th: (props) => (
                <th
                  className="px-3 py-2 text-left text-xs font-semibold"
                  {...props}
                />
              ),
              td: (props) => <td className="px-3 py-2 text-xs" {...props} />,
              strong: (props) => (
                <strong className="font-semibold" {...props} />
              ),
              a: (props) => (
                <a
                  className="text-primary underline underline-offset-2"
                  target="_blank"
                  rel="noopener noreferrer"
                  {...props}
                />
              ),
              hr: () => <hr className="my-5 border-border" />,
            }}
          >
            {content}
          </ReactMarkdown>
        </article>
      </SheetContent>
    </Sheet>
  );
}
