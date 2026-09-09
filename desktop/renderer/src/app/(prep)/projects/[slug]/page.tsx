import { PROJECTS, getProject } from "@/lib/projects";
import ProjectDetail from "@/components/Projects/ProjectDetail";

/**
 * Static export needs every dynamic route enumerated at build time — there is no server to
 * render an unknown slug on demand.
 */
export function generateStaticParams() {
  return PROJECTS.map((project) => ({ slug: project.slug }));
}

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  // Next 16: dynamic route params arrive as a promise.
  const { slug } = await params;
  const project = getProject(slug);

  if (project === undefined) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-ink-3">No such project.</p>
      </div>
    );
  }

  return <ProjectDetail project={project} />;
}
