import ReactMarkdown from "react-markdown";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

/**
 * Read-only renderer for the knowledge base's markdown source. Mirrors the
 * component-override styling used elsewhere (mock-time api docs) since the
 * project has no Tailwind typography plugin. Internal `/knowledge/...` links are
 * routed through next-intl's locale-aware <Link>; everything else opens in a new
 * tab with safe rel.
 */
export function MarkdownContent({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <article className={cn("max-w-none", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // rehype-slug stamps stable ids on headings so the on-page table of
        // contents can anchor-link and scroll-spy them.
        rehypePlugins={[rehypeSlug]}
        components={{
          h1: (props) => (
            <h1
              className="text-2xl font-semibold mt-8 mb-3 first:mt-0"
              {...props}
            />
          ),
          h2: (props) => (
            <h2 className="text-xl font-semibold mt-6 mb-2" {...props} />
          ),
          h3: (props) => (
            <h3 className="text-base font-semibold mt-5 mb-2" {...props} />
          ),
          p: (props) => (
            <p className="leading-relaxed my-3 text-foreground/90" {...props} />
          ),
          ul: (props) => (
            <ul
              className="list-disc pl-5 my-3 space-y-1 text-foreground/90"
              {...props}
            />
          ),
          ol: (props) => (
            <ol
              className="list-decimal pl-5 my-3 space-y-1 text-foreground/90"
              {...props}
            />
          ),
          a: ({ href, children, ...props }) => {
            const internal = href?.match(
              /^(?:\/[a-z]{2})?\/knowledge\/[a-z0-9-]+$/
            );
            if (internal && href) {
              // Strip any locale prefix; <Link> re-adds the active one.
              const path = href.replace(/^\/[a-z]{2}\//, "/");
              return (
                <Link
                  href={path}
                  className="text-primary underline underline-offset-2"
                >
                  {children}
                </Link>
              );
            }
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-2"
                {...props}
              >
                {children}
              </a>
            );
          },
          code: ({ className: cls, children, ...props }) => {
            const isBlock = cls?.startsWith("language-");
            if (isBlock) {
              return (
                <code className={cls} {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code
                className="rounded bg-muted px-1.5 py-0.5 text-sm font-mono"
                {...props}
              >
                {children}
              </code>
            );
          },
          pre: (props) => (
            <pre
              className="my-4 rounded-md border bg-muted/50 p-3 overflow-x-auto text-sm font-mono leading-relaxed"
              {...props}
            />
          ),
          blockquote: (props) => (
            <blockquote
              className="my-3 border-l-2 pl-4 italic text-muted-foreground"
              {...props}
            />
          ),
          table: (props) => (
            <div className="my-4 overflow-x-auto rounded-md border">
              <table className="w-full text-sm" {...props} />
            </div>
          ),
          th: (props) => (
            <th
              className="border-b bg-muted/50 px-3 py-2 text-left font-medium"
              {...props}
            />
          ),
          td: (props) => <td className="border-b px-3 py-2" {...props} />,
          hr: () => <hr className="my-6 border-border" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </article>
  );
}
