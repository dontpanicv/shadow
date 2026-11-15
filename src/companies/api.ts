import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";
import type { Role } from "./companies.ts";

/** Companies, their channels, and their members for the web app. */
export const companyApiRoutes: readonly Route[] = [
  [
    "GET",
    "/api/v1/me",
    api(async ({ app, user }) => {
      // Shadow has one company; the first allowed person starts it as its first admin, and the others wait for one.
      if (
        app.companies.ids().length === 0 &&
        user.email.toLowerCase() === app.config.allowedEmails[0]
      ) {
        await app.companies.create(user, "Shadow");
      }
      await app.pictures.importGoogle(user.id);
      const companies = app.companies.list(user);
      for (const company of companies) {
        app.companies.personalChannelOf(company.id, user);
      }
      return json({
        user: { ...user, picture: app.companies.pictureOf(user) },
        companies,
        admin: app.companies.isAdmin(user),
      });
    }),
  ],
  [
    "POST",
    "/api/v1/me/picture",
    api(async ({ app, user, files }) => {
      await app.pictures.set(user.id, files[0]);
      return json({ picture: app.companies.pictureOf(user) });
    }),
  ],
  [
    "DELETE",
    "/api/v1/me/picture",
    api(async ({ app, user }) => {
      app.pictures.remove(user.id);
      return new Response(null, { status: 204 });
    }),
  ],
  [
    "GET",
    "/api/v1/pictures/:picture",
    api(async ({ app, user, params }) => {
      const picture = app.companies.picture(params.picture!, user);
      return new Response(picture.data, {
        headers: {
          "content-type": picture.contentType,
          "x-content-type-options": "nosniff",
          // A new picture gets a new id, so this one never changes.
          "cache-control": "private, max-age=31536000, immutable",
        },
      });
    }),
  ],
  [
    "GET",
    "/api/v1/companies/:company",
    api(async ({ app, user, params }) =>
      json({
        company: app.companies.requireMember(params.company!, user),
        channels: app.companies.channels(params.company!, user),
        pinned: app.companies.pins(params.company!, user),
      })
    ),
  ],
  [
    "PUT",
    "/api/v1/companies/:company",
    api(async ({ app, user, params, body }) =>
      json(app.companies.rename(params.company!, user, body.name as string))
    ),
  ],
  [
    "POST",
    "/api/v1/companies/:company/channels",
    api(async ({ app, user, params, body }) =>
      json(
        app.companies.createChannel(params.company!, user, body.name as string)
      )
    ),
  ],
  [
    "PUT",
    "/api/v1/companies/:company/channels/:channel",
    api(async ({ app, user, params, body }) =>
      json(
        app.companies.renameChannel(
          params.company!,
          user,
          params.channel!,
          body.name as string
        )
      )
    ),
  ],
  [
    "PUT",
    "/api/v1/companies/:company/channels/:channel/pin",
    api(async ({ app, user, params }) => {
      app.companies.pin(params.company!, user, params.channel!, true);
      return new Response(null, { status: 204 });
    }),
  ],
  [
    "DELETE",
    "/api/v1/companies/:company/channels/:channel/pin",
    api(async ({ app, user, params }) => {
      app.companies.pin(params.company!, user, params.channel!, false);
      return new Response(null, { status: 204 });
    }),
  ],
  [
    "GET",
    "/api/v1/companies/:company/facts",
    api(async ({ app, user, params }) =>
      json(app.companies.facts(params.company!, user))
    ),
  ],
  [
    "PUT",
    "/api/v1/companies/:company/facts",
    api(async ({ app, user, params, body }) =>
      json(app.companies.setFacts(params.company!, user, body.text as string))
    ),
  ],
  [
    "GET",
    "/api/v1/companies/:company/members",
    api(async ({ app, user, params }) =>
      json(app.companies.members(params.company!, user))
    ),
  ],
  [
    "POST",
    "/api/v1/companies/:company/members",
    api(async ({ app, user, params, body }) =>
      json(
        await app.companies.addMember(
          params.company!,
          user,
          body.email as string
        )
      )
    ),
  ],
  [
    "PUT",
    "/api/v1/companies/:company/members/:member",
    api(async ({ app, user, params, body }) =>
      json(
        app.companies.setRole(
          params.company!,
          user,
          params.member!,
          body.role as Role
        )
      )
    ),
  ],
];
