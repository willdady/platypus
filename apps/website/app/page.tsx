import type { ComponentType, FC, ReactNode, SVGProps } from "react";
import { Fragment } from "react";
import Image from "next/image";
import {
  ArrowRight,
  BookOpen,
  Bot,
  Brain,
  Check,
  Layers,
  Plug,
  Server,
  SquareKanban,
  Wrench,
  Zap,
} from "lucide-react";
import { SiteNav } from "./components/site-nav";
import { HeroImage } from "./components/hero-image";
import { Placeholder } from "./components/placeholder";
import { DOCS_URL, GITHUB_URL } from "./components/sections";
import { GitHubIcon } from "./components/icons";

type LucideIcon = ComponentType<SVGProps<SVGSVGElement>>;

// Smaller capabilities shown as a grid. Agents and Boards are promoted to their
// own dedicated sections below, so they're intentionally absent here.
const FEATURES: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: Plug,
    title: "Multi-provider",
    body: "Connect OpenAI, Anthropic, Google, Bedrock, OpenRouter and more. You bring the models and credentials; switch providers per agent without rewiring anything.",
  },
  {
    icon: Wrench,
    title: "Tools via MCP",
    body: "Grant agents tool sets backed by Model Context Protocol servers or registered in code — so they can act on your data, not just talk about it.",
  },
  {
    icon: Zap,
    title: "Triggers",
    body: "Run agents automatically — on a cron schedule or in response to workspace events like a card moving on a board. Each trigger fires an agent with a fixed instruction and records the result.",
  },
  {
    icon: Server,
    title: "Self-hosted",
    body: "Runs on your own infrastructure with Docker Compose. Postgres-backed, no managed service required — your data and keys stay with you.",
  },
  {
    icon: Layers,
    title: "Multi-tenant",
    body: "Organizations contain workspaces; workspaces contain chats, agents, MCPs, and providers. Scope resources tightly or share them across an org.",
  },
  {
    icon: Brain,
    title: "Memory & context",
    body: "Per-user, per-workspace memory and free-text context are rendered into the system prompt, so agents carry what matters between conversations.",
  },
];

const STEPS = [
  {
    title: "Create a workspace",
    body: "Spin up a scoped environment inside your organization to hold chats, agents, and connections.",
  },
  {
    title: "Configure a provider",
    body: "Add credentials for an AI vendor and enable the models you want available.",
  },
  {
    title: "Create an agent",
    body: "Pin a provider, model, and system prompt, then grant it skills and MCP tool sets.",
  },
  {
    title: "Start a chat & send a message",
    body: "Select your agent on a chat turn and watch it reason, call tools, and stream a reply.",
  },
];

const Section: FC<{
  id?: string;
  className?: string;
  children: ReactNode;
}> = ({ id, className = "", children }) => (
  <section
    id={id}
    className={`mx-auto w-full max-w-6xl px-4 sm:px-6 ${className}`}
  >
    {children}
  </section>
);

// A dedicated, two-column feature section: copy + bullet points on one side, an
// (placeholder) screenshot on the other. `reverse` flips which side the image
// sits on so consecutive sections alternate.
const FeatureSection: FC<{
  id: string;
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  body: string;
  points: string[];
  imageLabel: string;
  // When provided, the real screenshot renders instead of the placeholder.
  image?: { src: string; width: number; height: number };
  reverse?: boolean;
}> = ({
  id,
  icon: Icon,
  eyebrow,
  title,
  body,
  points,
  imageLabel,
  image,
  reverse,
}) => (
  <Section id={id} className="py-12 sm:py-28">
    <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-5 lg:gap-16">
      <div className={`lg:col-span-2 ${reverse ? "lg:order-2" : ""}`}>
        <div className="inline-flex items-center gap-2 text-sm font-semibold text-primary-bright">
          <Icon className="size-5" />
          {eyebrow}
        </div>
        <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
          {title}
        </h2>
        <p className="mt-4 text-lg text-muted-foreground">{body}</p>
        <ul className="mt-6 flex flex-col gap-3">
          {points.map((point) => (
            <li key={point} className="flex items-start gap-3">
              <Check className="mt-0.5 size-5 shrink-0 text-primary-bright" />
              <span className="text-muted-foreground">{point}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className={`lg:col-span-3 ${reverse ? "lg:order-1" : ""}`}>
        {image ? (
          <Image
            src={image.src}
            alt={imageLabel}
            width={image.width}
            height={image.height}
            className="h-auto w-full rounded-xl border border-border shadow-2xl shadow-black/40"
          />
        ) : (
          <Placeholder label={imageLabel} />
        )}
      </div>
    </div>
  </Section>
);

export default function HomePage() {
  return (
    <>
      <SiteNav />
      <main id="top" className="pt-16">
        {/* Hero */}
        <Section className="flex flex-col items-center pt-24 text-center sm:pt-32">
          <h1 className="max-w-3xl text-balance text-4xl font-extrabold tracking-tight sm:text-6xl">
            Build and manage{" "}
            <span className="text-primary-bright">AI agents</span> on your own
            terms
          </h1>
          <p className="mt-6 max-w-2xl text-pretty text-lg text-muted-foreground sm:text-xl">
            Platypus is an open-source, MIT-licensed platform for agents that
            reason, use tools, and connect to your data. Self-hosted and
            multi-tenant — you bring the models, Platypus gives you everything
            around them.
          </p>
          <div className="mt-10 flex flex-row items-center justify-center gap-3">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
            >
              <GitHubIcon className="size-5" />
              View on GitHub
            </a>
            <a
              href="#get-started"
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-5 py-3 text-sm font-semibold transition-colors hover:bg-accent"
            >
              Get started
              <ArrowRight className="size-4" />
            </a>
          </div>
        </Section>

        {/* App screenshot */}
        <Section className="pt-12 sm:pt-16">
          <HeroImage />
        </Section>

        {/* Features */}
        <Section id="features" className="py-12 sm:py-28">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
              Everything you need to harness AI
            </h2>
            <p className="mt-4 text-lg text-muted-foreground">
              The hard parts of putting agents to work — providers, tools,
              automation, tenancy, and memory — handled.
            </p>
          </div>
          <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <div
                key={title}
                className="rounded-xl border border-border bg-card p-6 transition-colors hover:border-primary/50"
              >
                <div className="mb-4 inline-flex size-11 items-center justify-center rounded-lg bg-primary/10 text-primary-bright">
                  <Icon className="size-6" />
                </div>
                <h3 className="text-lg font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {body}
                </p>
              </div>
            ))}
          </div>
        </Section>

        {/* Agents */}
        <FeatureSection
          id="agents"
          icon={Bot}
          eyebrow="Agents"
          title="Agents that reason, act, and delegate"
          body="Give an agent a provider, model, and system prompt, then arm it with tool sets, skills, and sub-agents. It plans, calls tools in a loop to get the job done, and hands off to specialist agents when a task calls for them."
          points={[
            "Pair any provider and model with a system prompt that shapes how it behaves",
            "Grant tool sets and skills, and cap the tool-calling loop with max steps",
            "Compose agents from sub-agents, each exposed to the parent as a delegate tool",
          ]}
          imageLabel="A list of configured agents in a Platypus workspace"
          image={{ src: "/agents.png", width: 1100, height: 780 }}
        />

        {/* Boards */}
        <FeatureSection
          id="boards"
          icon={SquareKanban}
          eyebrow="Kanban boards"
          title="A shared surface for you and your agents"
          body="A board is scoped to your workspace — columns, cards, labels, and priorities. Both you and your agents read and update the same board, so it's a natural place to track and hand off work."
          points={[
            "Drag cards across columns, with labels and priorities to organize your work",
            "Grant the Kanban tool set and an agent can create, move, and comment on cards",
            "Board changes fire event triggers that can kick off the next agent run",
          ]}
          imageLabel="A Kanban board in a Platypus workspace with columns of cards"
          image={{ src: "/boards.png", width: 2714, height: 1442 }}
          reverse
        />

        {/* How it works */}
        <Section id="how-it-works" className="py-12 sm:py-28">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
              Structure that scales with you
            </h2>
            <p className="mt-4 text-lg text-muted-foreground">
              Platypus is organized as a simple hierarchy, so a solo project and
              a whole organization use the same primitives.
            </p>
          </div>
          <div className="mt-14 flex flex-col items-stretch justify-center gap-4 lg:flex-row lg:items-center">
            {[
              {
                name: "Organization",
                body: "The top-level tenant. Owns workspaces, org-scoped providers, and member roles.",
              },
              {
                name: "Workspace",
                body: "A scoped environment holding chats, agents, tools, skills, and providers.",
              },
              {
                name: "Agent",
                body: "A configured worker: provider, model, prompt, tools, skills, and sub-agents.",
              },
            ].map((node, i, arr) => (
              <Fragment key={node.name}>
                <div className="flex-1 rounded-xl border border-border bg-card p-6 lg:max-w-xs">
                  <h3 className="text-lg font-semibold text-primary-bright">
                    {node.name}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {node.body}
                  </p>
                </div>
                {i < arr.length - 1 && (
                  <div
                    className="flex shrink-0 justify-center text-muted-foreground"
                    aria-hidden="true"
                  >
                    <ArrowRight className="size-5 rotate-90 lg:rotate-0" />
                  </div>
                )}
              </Fragment>
            ))}
          </div>
        </Section>

        {/* Get started */}
        <Section id="get-started" className="py-12 sm:py-28">
          <div className="rounded-2xl border border-border bg-card p-8 sm:p-12">
            <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-2">
              <div>
                <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
                  Up and running in minutes
                </h2>
                <p className="mt-4 text-lg text-muted-foreground">
                  Clone the repo and bring it up with Docker Compose, then
                  follow the four-step loop to your first streamed reply.
                </p>
                <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                  <a
                    href={GITHUB_URL}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
                  >
                    <GitHubIcon className="size-5" />
                    Get the code
                  </a>
                  <a
                    href={`${DOCS_URL}/getting-started`}
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-border px-5 py-3 text-sm font-semibold transition-colors hover:bg-accent"
                  >
                    <BookOpen className="size-4" />
                    Read the docs
                  </a>
                </div>
              </div>
              <div className="min-w-0 rounded-xl border border-border bg-background p-5 font-mono text-sm">
                <pre className="overflow-x-auto whitespace-pre text-muted-foreground">
                  <code>
                    <span className="text-muted-foreground/60">
                      # clone and configure
                    </span>
                    {"\n"}
                    <span className="text-primary-bright">git</span> clone
                    https://github.com/willdady/platypus.git{"\n"}
                    <span className="text-primary-bright">cd</span> platypus
                    {"\n"}
                    <span className="text-primary-bright">cp</span> .env.example
                    .env
                    {"\n\n"}
                    <span className="text-muted-foreground/60">
                      # bring it up
                    </span>
                    {"\n"}
                    <span className="text-primary-bright">docker</span> compose
                    up
                  </code>
                </pre>
              </div>
            </div>
            <ol className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {STEPS.map((step, i) => (
                <li key={step.title}>
                  <div className="mb-3 inline-flex size-8 items-center justify-center rounded-full border border-primary/40 text-sm font-semibold text-primary-bright">
                    {i + 1}
                  </div>
                  <h3 className="font-semibold">{step.title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    {step.body}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </Section>

        {/* Footer */}
        <footer className="border-t border-border">
          <Section className="flex flex-col items-center justify-between gap-4 py-10 sm:flex-row">
            <div className="flex flex-col items-center gap-1 text-sm text-muted-foreground sm:items-start">
              <span>© 2026 Platypus</span>
              <span>
                Platypus logo by{" "}
                <a
                  href="https://www.thiings.co/"
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline underline-offset-2 transition-colors hover:text-foreground"
                >
                  Thiings.co
                </a>
              </span>
            </div>
            <div className="flex items-center gap-6 text-sm">
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-2 text-muted-foreground transition-colors hover:text-foreground"
              >
                <GitHubIcon className="size-4" />
                GitHub
              </a>
              <a
                href={DOCS_URL}
                className="inline-flex items-center gap-2 text-muted-foreground transition-colors hover:text-foreground"
              >
                <BookOpen className="size-4" />
                Docs
              </a>
            </div>
          </Section>
        </footer>
      </main>
    </>
  );
}
