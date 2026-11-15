import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";

/**
 * The artifacts of a channel, and the workspace's own, for the web app. Agents make and change them; people open them,
 * change who sees them, and delete them or their data. The app shows an artifact in a frame of its link page, whose
 * `shadow` calls go to `/a/:artifact/rpc`.
 */
export const artifactApiRoutes: readonly Route[] = [
  [
    "GET",
    "/api/v1/workspaces/:workspace/channels/:channel/artifacts",
    api(async ({ app, user, params }) =>
      json({
        artifacts: app.artifacts.inPlace(
          params.workspace!,
          params.channel!,
          user
        ),
      })
    ),
  ],
  [
    "GET",
    "/api/v1/workspaces/:workspace/artifacts",
    api(async ({ app, user, params }) =>
      json({ artifacts: app.artifacts.inPlace(params.workspace!, null, user) })
    ),
  ],
  [
    "GET",
    "/api/v1/artifacts/:artifact",
    api(async ({ app, user, params }) => {
      const artifact = app.artifacts.get(params.artifact!, user);
      return json({
        artifact,
        records: app.artifacts.dataFor(artifact.id, user),
      });
    }),
  ],
  [
    "PUT",
    "/api/v1/artifacts/:artifact",
    api(async ({ app, user, params, body }) =>
      json(app.artifacts.setVisibility(params.artifact!, user, body.visibility))
    ),
  ],
  [
    "DELETE",
    "/api/v1/artifacts/:artifact",
    api(async ({ app, user, params }) => {
      app.artifacts.delete(params.artifact!, user);
      return new Response(null, { status: 204 });
    }),
  ],
  [
    "DELETE",
    "/api/v1/artifacts/:artifact/data",
    api(async ({ app, user, params }) => {
      app.artifacts.clearData(params.artifact!, user);
      return new Response(null, { status: 204 });
    }),
  ],
  [
    "DELETE",
    "/api/v1/artifacts/:artifact/records/:record",
    api(async ({ app, user, params }) => {
      app.artifacts.deleteRecordFor(params.artifact!, user, params.record!);
      return new Response(null, { status: 204 });
    }),
  ],
];
