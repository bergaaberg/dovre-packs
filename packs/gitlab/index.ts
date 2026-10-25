/**
 * GitLab Pack (`gitlab`): GitLab as Dovre's forge. With FORGE=gitlab, merge requests, CI, todos,
 * project activity and blocked deployments come from GitLab instead of GitHub (one forge per instance).
 * REPO_OWNERS lists the top-level groups to track; their subgroups come along.
 */
import { type Pack, PACK_API } from "dovre/packs/types.ts";
import { createGitLab, type Fetch, gitlabForge, hostOf } from "./forge.ts";

export function createGitlabPack(opts: { fetchFn?: Fetch } = {}): Pack {
  return {
    manifest: {
      api: PACK_API,
      id: "gitlab",
      name: "GitLab",
      description: "GitLab as the forge: merge requests, pipelines, todos, activity and blocked deployments (set FORGE=gitlab).",
      domain: "work",
      execution: "any",
      settings: [
        { key: "GITLAB_HOST", label: "GitLab host", help: "gitlab.com (the default) or your self-managed host" },
        { key: "GITLAB_TOKEN", label: "GitLab access token", secret: true, required: true, help: "A personal access token with the read_api scope" },
      ],
    },
    forge: {
      id: "gitlab",
      name: "GitLab",
      create(env) {
        const token = env.GITLAB_TOKEN?.trim();
        if (!token) throw new Error("GITLAB_TOKEN isn't set: add a personal access token with the read_api scope.");
        return gitlabForge(createGitLab({ host: hostOf(env.GITLAB_HOST), token, fetchFn: opts.fetchFn }));
      },
    },
  };
}

export const gitlabPack: Pack = createGitlabPack();
