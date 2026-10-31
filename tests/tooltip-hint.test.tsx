import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { TooltipHint } from "@/components/ui/tooltip";

// A tooltip around a menu/popover trigger must keep the trigger's wiring and
// its icon; wrapping the Button inside the trigger's render prop loses both.

describe("TooltipHint", () => {
  it("keeps a dropdown trigger's icon and menu wiring", () => {
    const html = renderToString(
      <DropdownMenu>
        <TooltipHint label="More">
          <DropdownMenuTrigger
            render={<Button size="icon" aria-label="More" />}
          >
            <i data-testid="icon" />
          </DropdownMenuTrigger>
        </TooltipHint>
      </DropdownMenu>
    );
    expect(html).toContain('<i data-testid="icon"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="More"');
  });

  it("keeps a popover trigger's icon and wiring", () => {
    const html = renderToString(
      <Popover>
        <TooltipHint label="Link">
          <PopoverTrigger render={<Button size="icon" aria-label="Link" />}>
            <i data-testid="icon" />
          </PopoverTrigger>
        </TooltipHint>
      </Popover>
    );
    expect(html).toContain('<i data-testid="icon"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
  });

  it("wraps a plain button", () => {
    const html = renderToString(
      <TooltipHint label="Go">
        <Button size="icon" aria-label="Go">
          <i data-testid="icon" />
        </Button>
      </TooltipHint>
    );
    expect(html).toContain('<i data-testid="icon"');
    expect(html).toContain('aria-label="Go"');
  });
});
