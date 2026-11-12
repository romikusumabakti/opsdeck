import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { z } from "zod";
import { AdvancedOptions } from "@/components/advanced-options";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { useRouter } from "@/i18n/navigation";
import { ApiError } from "@/web/api/client";
import {
  getAuthorizedKeysLineQuery,
  getInstanceSshKeyQuery,
} from "@/web/api/instance";
import {
  createServer,
  reinstallServerKey,
  type ServerRow as Server,
  testServerConnection,
  updateServer,
} from "@/web/api/servers";

const PLACEMENTS = ["restricted", "open"] as const;

// How a new server gets the instance key: the admin runs the command shown
// (nothing secret is sent), or types the password once and the Panel installs
// it (the password is never stored).
const METHODS = ["key", "passwordOnce"] as const;
type Method = (typeof METHODS)[number];

// How long the from= field must rest before its command is fetched.
const FROM_DEBOUNCE_MS = 400;

type Mode = { type: "create" } | { type: "edit"; server: Server };

type Props = {
  mode: Mode;
  /**
   * Optional callbacks to override default navigation behaviour. When provided,
   * the form skips `router.push("/servers")` so it can be embedded in a modal.
   */
  onSuccess?: (server: Server) => void;
  onCancel?: () => void;
  // Show the stored values without edit, test or save controls (callers
  // without server:manage).
  readOnly?: boolean;
};

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok" }
  | { kind: "fail"; message: string };

export function ServerForm({
  mode,
  onSuccess,
  onCancel,
  readOnly = false,
}: Props) {
  const t = useTranslations("serverForm");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const initial = mode.type === "edit" ? mode.server : null;

  const creating = mode.type === "create";
  const schema = z
    .object({
      name: z.string().min(1, tCommon("required")),
      host: z.string().min(1, tCommon("required")),
      username: z.string().min(1, tCommon("required")),
      method: z.enum(METHODS),
      sshFrom: z.string(),
      password: z.string(),
      sftpRoot: z
        .string()
        .min(1, tCommon("required"))
        .regex(/^\//, t("sftpRootInvalid")),
      placement: z.enum(PLACEMENTS),
      infraOnly: z.boolean(),
    })
    .superRefine((values, ctx) => {
      if (!creating) return;
      if (values.method === "key" && !values.sshFrom.trim()) {
        ctx.addIssue({
          code: "custom",
          path: ["sshFrom"],
          message: tCommon("required"),
        });
      }
      if (values.method === "passwordOnce" && !values.password) {
        ctx.addIssue({
          code: "custom",
          path: ["password"],
          message: tCommon("required"),
        });
      }
    });

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: initial?.name ?? "",
      host: initial?.host ?? "",
      username: initial?.username ?? "",
      method: "key",
      sshFrom: "",
      password: "",
      sftpRoot: initial?.sftpRoot ?? "/",
      placement: initial?.placement ?? "restricted",
      infraOnly: initial?.infraOnly ?? false,
    },
  });

  const [testState, setTestState] = useState<TestState>({ kind: "idle" });

  function resetTest() {
    setTestState({ kind: "idle" });
  }

  const watched = form.watch();

  async function onTest() {
    setTestState({ kind: "testing" });
    const payload: {
      host: string;
      username: string;
      password?: string;
      serverId?: string;
      auth?: "key";
    } = {
      host: watched.host.trim(),
      username: watched.username.trim(),
    };
    if (creating && watched.method === "key") payload.auth = "key";
    else if (watched.password.length > 0) payload.password = watched.password;
    if (mode.type === "edit") payload.serverId = mode.server.id;

    const result = await testServerConnection(payload);
    if (result.ok) {
      setTestState({ kind: "ok" });
    } else {
      setTestState({ kind: "fail", message: result.message });
    }
  }

  async function onSubmit(values: z.infer<typeof schema>) {
    if (mode.type === "create") {
      const fields = {
        name: values.name.trim(),
        host: values.host.trim(),
        username: values.username.trim(),
        sftpRoot: values.sftpRoot.trim(),
        placement: values.placement,
        infraOnly: values.infraOnly,
      };
      // The password of the passwordOnce method never goes into the row: the
      // server is created without one, then the key is installed with it.
      const result = await createServer(
        values.method === "key"
          ? { ...fields, auth: "key", sshFrom: values.sshFrom.trim() }
          : fields
      );
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      const created = result.data;
      // Created: from here on the form never creates again. What is left is
      // done on the new server's page (its saved key and from=, or the move).
      if (values.method === "passwordOnce") {
        try {
          await reinstallServerKey(created.id, values.password);
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) throw error;
          const message =
            error instanceof ApiError ? error.message : tCommon("errorGeneric");
          // Still on no password: its page shows Needs setup and offers the
          // move again.
          toast.error(t("keyNotInstalled", { message }));
          if (onSuccess) onSuccess(created);
          else router.push(`/servers/${created.id}`);
          return;
        }
      }
      toast.success(result.message ?? "");
      if (onSuccess) {
        onSuccess(created);
        return;
      }
      // A key installed by hand is not verified yet: its page shows the
      // command for the saved row and Check key login.
      router.push(
        values.method === "key" ? `/servers/${created.id}` : "/servers"
      );
      return;
    }

    const data: {
      name: string;
      host: string;
      username: string;
      password?: string;
      sftpRoot: string;
      placement: (typeof PLACEMENTS)[number];
      infraOnly: boolean;
    } = {
      name: values.name.trim(),
      host: values.host.trim(),
      username: values.username.trim(),
      sftpRoot: values.sftpRoot.trim(),
      placement: values.placement,
      infraOnly: values.infraOnly,
    };
    if (values.password.length > 0) data.password = values.password;

    const result = await updateServer(mode.server.id, data);
    if (!result.success) {
      toast.error(result.message);
      return;
    }
    toast.success(result.message ?? "");
    router.push("/servers");
  }

  function handleCancel() {
    if (onCancel) {
      onCancel();
      return;
    }
    router.push("/servers");
  }

  const loading = form.formState.isSubmitting;

  useUnsavedChanges(form.formState.isDirty && !loading);

  // Test button is enabled when host & username are filled and there is a way
  // to sign in: the key (new server installed by hand, or a saved server's
  // stored password or key) or a typed password.
  const canTest =
    watched.host.trim().length > 0 &&
    watched.username.trim().length > 0 &&
    (mode.type === "edit" ||
      watched.method === "key" ||
      watched.password.length > 0) &&
    testState.kind !== "testing" &&
    !loading;

  // A saved server's password is an advanced setting, and only exists while
  // it signs in with one; a key server has none.
  const passwordField = (
    <FormField
      control={form.control}
      name="password"
      render={({ field }) => (
        <FormItem>
          <FormLabel>
            {creating ? t("passwordOnce") : t("passwordEdit")}
          </FormLabel>
          <FormControl>
            <PasswordInput
              autoComplete="new-password"
              placeholder={creating ? undefined : t("passwordEditPlaceholder")}
              {...field}
              onChange={(e) => {
                resetTest();
                field.onChange(e);
              }}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="flex flex-col gap-4"
      >
        {/* Read-only callers (no manage permission) see the stored values with
            every input disabled and no test/save controls. */}
        <fieldset disabled={readOnly} className="contents">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("name")}</FormLabel>
                <FormControl>
                  <Input placeholder={t("namePlaceholder")} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="host"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("host")}</FormLabel>
                <FormControl>
                  <Input
                    placeholder="192.168.x.x"
                    {...field}
                    onChange={(e) => {
                      resetTest();
                      field.onChange(e);
                    }}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="username"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("username")}</FormLabel>
                <FormControl>
                  <Input
                    autoComplete="off"
                    {...field}
                    onChange={(e) => {
                      resetTest();
                      field.onChange(e);
                    }}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          {creating ? (
            <>
              <FormField
                control={form.control}
                name="method"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("accessMethod")}</FormLabel>
                    <RadioGroup
                      value={field.value}
                      onValueChange={(v) => {
                        resetTest();
                        // A password typed for the other method is dropped.
                        form.setValue("password", "");
                        field.onChange(v as Method);
                      }}
                    >
                      {METHODS.map((method) => (
                        <FieldLabel key={method} htmlFor={`method-${method}`}>
                          <Field orientation="horizontal">
                            <RadioGroupItem
                              value={method}
                              id={`method-${method}`}
                            />
                            <FieldContent>
                              <FieldTitle>
                                {method === "key"
                                  ? t("methodKey")
                                  : t("methodPassword")}
                              </FieldTitle>
                              <FieldDescription>
                                {method === "key"
                                  ? t("methodKeyDescription")
                                  : t("methodPasswordDescription")}
                              </FieldDescription>
                            </FieldContent>
                          </Field>
                        </FieldLabel>
                      ))}
                    </RadioGroup>
                  </FormItem>
                )}
              />
              {watched.method === "key" ? (
                <KeyInstall
                  sshFrom={
                    <FormField
                      control={form.control}
                      name="sshFrom"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("sshFrom")}</FormLabel>
                          <FormControl>
                            <Input
                              autoComplete="off"
                              placeholder={t("sshFromPlaceholder")}
                              {...field}
                            />
                          </FormControl>
                          <FormDescription>
                            {t("sshFromDescription")}
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  }
                  from={watched.sshFrom.trim()}
                />
              ) : (
                passwordField
              )}
            </>
          ) : null}
          <FormField
            control={form.control}
            name="sftpRoot"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("sftpRoot")}</FormLabel>
                <FormControl>
                  <Input placeholder="/" {...field} />
                </FormControl>
                <FormDescription>{t("sftpRootDescription")}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="placement"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("placement")}</FormLabel>
                <Select
                  value={field.value}
                  onValueChange={(v) => v && field.onChange(v)}
                  disabled={readOnly}
                >
                  <FormControl>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="restricted">
                      {t("placementRestricted")}
                    </SelectItem>
                    <SelectItem value="open">{t("placementOpen")}</SelectItem>
                  </SelectContent>
                </Select>
                <FormDescription>{t("placementDescription")}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="infraOnly"
            render={({ field }) => (
              <FormItem className="flex items-center justify-between gap-4">
                <div className="space-y-1">
                  <FormLabel>{t("infraOnly")}</FormLabel>
                  <FormDescription>{t("infraOnlyDescription")}</FormDescription>
                </div>
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    disabled={readOnly}
                  />
                </FormControl>
              </FormItem>
            )}
          />
          {!creating && initial?.auth === "password" ? (
            <AdvancedOptions>{passwordField}</AdvancedOptions>
          ) : null}
        </fieldset>

        {readOnly ? null : (
          <div className="flex items-center gap-3 flex-wrap">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onTest}
              disabled={!canTest}
            >
              {testState.kind === "testing" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              {t("testConnection")}
            </Button>
            <TestStatus state={testState} t={t} />
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="ghost"
            onClick={handleCancel}
            disabled={loading}
          >
            {tCommon("cancel")}
          </Button>
          {readOnly ? null : (
            <Button type="submit" disabled={loading}>
              {loading
                ? t("submitting")
                : mode.type === "edit"
                  ? t("saveChanges")
                  : t("create")}
            </Button>
          )}
        </div>
      </form>
    </Form>
  );
}

function TestStatus({
  state,
  t,
}: {
  state: TestState;
  t: (key: string) => string;
}) {
  if (state.kind === "idle" || state.kind === "testing") return null;
  if (state.kind === "ok") {
    return (
      <span className="text-sm text-success inline-flex items-center gap-1">
        <CheckCircle2 className="size-4" />
        {t("testSuccess")}
      </span>
    );
  }
  return (
    <span className="text-sm text-destructive inline-flex items-center gap-1 break-all">
      <XCircle className="size-4 shrink-0" />
      <span>
        {t("testFailed")}: {state.message}
      </span>
    </span>
  );
}

/**
 * The "install the key yourself" panel: the instance public key and, once the
 * from= address is typed, the one command that installs its authorized_keys
 * line (built by the server, so the line format lives in one place).
 */
function KeyInstall({
  sshFrom,
  from,
}: {
  sshFrom: React.ReactNode;
  from: string;
}) {
  const t = useTranslations("serverForm");
  const key = useQuery(getInstanceSshKeyQuery());
  const settled = useDebouncedValue(from, FROM_DEBOUNCE_MS);
  // Only the command for the address in the field is ever shown.
  const current = settled === from && from.length > 0;
  const line = useQuery({
    ...getAuthorizedKeysLineQuery(settled),
    enabled: current,
  });

  return (
    <div className="flex flex-col gap-4 rounded-lg border bg-muted/30 p-4">
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">{t("publicKey")}</span>
        {key.data ? (
          <div className="flex items-start gap-2">
            <code className="min-w-0 flex-1 break-all font-mono text-sm">
              {key.data.publicKey}
            </code>
            <CopyButton value={key.data.publicKey} />
          </div>
        ) : (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        )}
      </div>
      {sshFrom}
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">{t("installCommand")}</span>
        {from.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("installCommandEmpty")}
          </p>
        ) : current && line.isError ? (
          <p className="text-sm text-destructive">
            {line.error instanceof ApiError
              ? line.error.message
              : String(line.error)}
          </p>
        ) : current && line.data ? (
          <div className="flex items-start gap-2">
            <code className="min-w-0 flex-1 break-all rounded-md bg-background p-2 font-mono text-sm">
              {line.data.command}
            </code>
            <CopyButton value={line.data.command} />
          </div>
        ) : (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        )}
      </div>
    </div>
  );
}
