import {
  QueryCache,
  QueryClient,
  QueryFunction,
  QueryFunctionContext,
  QueryKey,
  UseQueryOptions,
  UseSuspenseQueryOptions,
  hashKey,
  notifyManager,
} from "@tanstack/react-query";
import { ConvexHttpClient } from "convex/browser";
import {
  ConvexReactClient,
  ConvexReactClientOptions,
  Watch,
} from "convex/react";
import {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
  getFunctionName,
  PaginationResult,
} from "convex/server";
import type {
  PaginatedQueryReference,
  PaginatedQueryArgs,
  PaginatedQueryItem,
} from "convex/react";

type EmptyObject = Record<string, never>;
import { convexToJson } from "convex/values";

/**
 * Page parameter type for Convex paginated queries.
 * null = first page, string = cursor for subsequent pages.
 */
type ConvexPageParam = string | null;

// Re-export React Query-friendly names for Convex hooks.
// Never importing "convex/react" from application code should
// prevent import completion of the Convex `useQuery`.
export {
  useQuery as useConvexQuery,
  useQueries as useConvexQueries,
  usePaginatedQuery as useConvexPaginatedQuery,
  useMutation as useConvexMutation,
  useAction as useConvexAction,
  useConvex,
  useConvexAuth,
  optimisticallyUpdateValueInPaginatedQuery,
} from "convex/react";

// Re-export pagination types for convenience
export type {
  PaginatedQueryReference,
  PaginatedQueryArgs,
  PaginatedQueryItem,
} from "convex/react";

const isServer = typeof window === "undefined";

function isConvexSkipped(
  queryKey: readonly any[],
): queryKey is ["convexQuery" | "convexAction", unknown, "skip"] {
  return (
    queryKey.length >= 2 &&
    ["convexQuery", "convexAction"].includes(queryKey[0]) &&
    queryKey[2] === "skip"
  );
}

function isConvexQuery(
  queryKey: readonly any[],
): queryKey is [
  "convexQuery",
  FunctionReference<"query">,
  Record<string, any>,
  {},
] {
  return queryKey.length >= 2 && queryKey[0] === "convexQuery";
}

function isConvexAction(
  queryKey: readonly any[],
): queryKey is [
  "convexAction",
  FunctionReference<"action">,
  Record<string, any>,
  {},
] {
  return queryKey.length >= 2 && queryKey[0] === "convexAction";
}

function isConvexPaginatedQuery(
  queryKey: readonly any[],
): queryKey is [
  "convexPaginatedQuery",
  FunctionReference<"query">,
  Record<string, any>,
] {
  return queryKey.length >= 2 && queryKey[0] === "convexPaginatedQuery";
}

function hash(
  queryKey: [
    "convexQuery",
    FunctionReference<"query">,
    Record<string, any>,
    {},
  ],
): string {
  return `convexQuery|${getFunctionName(queryKey[1])}|${JSON.stringify(
    convexToJson(queryKey[2]),
  )}`;
}

function hashPaginatedQuery(
  queryKey: [
    "convexPaginatedQuery",
    FunctionReference<"query">,
    Record<string, any>,
  ],
): string {
  return `convexPaginatedQuery|${getFunctionName(queryKey[1])}|${JSON.stringify(
    convexToJson(queryKey[2]),
  )}`;
}

export interface ConvexQueryClientOptions extends ConvexReactClientOptions {
  /** queryClient can also be set later by calling .connect(ReactqueryClient) */
  queryClient?: QueryClient;
  /** A custom fetch implementation to use for all HTTP requests made on the server.
   *
   * Take care to avoid bundling this `fetch` implementation on the client
   * if you can help it. In TanStack Start you can use createServerOnlyFn
   * for this, see
   * https://tanstack.com/start/latest/docs/framework/react/guide/environment-functions#envonly-functions
   */
  serverFetch?: typeof globalThis.fetch | undefined;
  /**
   * opt out of consistent queries, resulting in (for now) faster SSR at the
   * cost of potential inconsistency between queries
   *
   * Why might you need this? Consistency is important when clients expect
   * multiple queries to make sense together, e.g. for "client-side joins."
   *
   * Say you make two queries that your React code expects to be from the same database state:
   *
   * ```
   * const channels = useQuery(api.channels.all)
   * const favChannelIds = useQuery(api.channels.favIds');
   * const favChannels = (channels && favChannels) ? favChannels.map(c => channels[c]) : []
   * ```
   *
   * During normal client operation, the `api.channels.all` and `api.channels.favIds`
   * queries will both return results from the same logical timestamp: as long as these
   * queries are written correctly, there will never be a favChannelId for a channel
   * not in favChannels.
   *
   * But during SSR, if this value is set, these two queries may return results
   * from different logical timestamps, as they're not just two HTTP requests.
   *
   * The upside of this is a faster SSR render: the current implementation
   * of a consistent SSR render involves two roundtrips instead of one.
   */
  dangerouslyUseInconsistentQueriesDuringSSR?: boolean;
}

/**
 * Subscribes to events from a TanStack Query QueryClient and populates query
 * results in it for all Convex query function subscriptions.
 */
export class ConvexQueryClient {
  convexClient: ConvexReactClient;
  subscriptions: Record<
    string, // queryKey hash
    {
      watch: Watch<any>;
      unsubscribe: () => void;
      queryKey: [
        convexKey: "convexQuery",
        func: FunctionReference<"query">,
        args: Record<string, any>,
        options?: {},
      ];
    }
  >;
  /**
   * Tracks subscriptions for paginated queries.
   * Each paginated query can have multiple page subscriptions (one per cursor).
   */
  paginatedSubscriptions: Record<
    string, // queryHash for the infinite query
    {
      funcRef: FunctionReference<"query">;
      baseArgs: Record<string, any>;
      numItems: number;
      pages: Map<
        string | null, // cursor (null = first page)
        { watch: Watch<any>; unsubscribe: () => void }
      >;
    }
  >;
  unsubscribe: (() => void) | undefined;
  // Only exists during SSR
  serverHttpClient?: ConvexHttpClient;
  _queryClient: QueryClient | undefined;
  ssrQueryMode: "consistent" | "inconsistent";
  get queryClient() {
    if (!this._queryClient) {
      throw new Error(
        "ConvexQueryClient not connected to TanStack QueryClient.",
      );
    }
    return this._queryClient;
  }
  constructor(
    /** A ConvexReactClient instance or a URL to use to instantiate one. */
    client: ConvexReactClient | string,
    /** Options mostly for the ConvexReactClient to be constructed. */
    options: ConvexQueryClientOptions = {},
  ) {
    if (typeof client === "string") {
      this.convexClient = new ConvexReactClient(client, options);
    } else {
      this.convexClient = client satisfies ConvexReactClient;
    }
    if (options.dangerouslyUseInconsistentQueriesDuringSSR) {
      this.ssrQueryMode = "inconsistent";
    } else {
      this.ssrQueryMode = "consistent";
    }
    this.subscriptions = {};
    this.paginatedSubscriptions = {};
    if (options.queryClient) {
      this._queryClient = options.queryClient;
      this.unsubscribe = this.subscribeInner(
        options.queryClient.getQueryCache(),
      );
    }
    if (isServer) {
      this.serverHttpClient = new ConvexHttpClient(this.convexClient.url, {
        fetch: options.serverFetch,
      });
    }
  }
  /** Complete initialization of ConvexQueryClient by connecting a TanStack QueryClient */
  connect(queryClient: QueryClient) {
    if (this.unsubscribe) {
      throw new Error("already subscribed!");
    }
    this._queryClient = queryClient;
    this.unsubscribe = this.subscribeInner(queryClient.getQueryCache());
  }

  /** Update every query key. Probably not useful, don't use this. */
  onUpdate = () => {
    // Fortunately this does not reset the gc time.
    notifyManager.batch(() => {
      for (const key of Object.keys(this.subscriptions)) {
        this.onUpdateQueryKeyHash(key);
      }
    });
  };
  onUpdateQueryKeyHash(queryHash: string) {
    const subscription = this.subscriptions[queryHash];
    if (!subscription) {
      // If we have no record of this subscription that should be a logic error.
      throw new Error(
        `Internal ConvexQueryClient error: onUpdateQueryKeyHash called for ${queryHash}`,
      );
    }

    const queryCache = this.queryClient.getQueryCache();
    const query = queryCache.get(queryHash);
    if (!query) return;

    const { queryKey, watch } = subscription;
    let result: { ok: true; value: any } | { ok: false; error: unknown };
    try {
      result = { ok: true, value: watch.localQueryResult() };
    } catch (error) {
      result = { ok: false, error };
    }

    if (result.ok) {
      const value = result.value;
      this.queryClient.setQueryData(queryKey, (prev) => {
        if (prev === undefined) {
          // If `prev` is undefined there is no react-query entry for this query key.
          // Return `undefined` to signal not to create one.
          return undefined;
        }
        return value;
      });
    } else {
      const { error } = result;
      // TODO This may not be a stable API. Devtools work this way so it's at
      // least used elsewhere. Either trigger a query by invalidating this query
      // (only feasible if guaranteed to update before the next tick) or
      // look into a `QueryClient.setQueryError` API.
      query?.setState(
        {
          error: error as Error,
          errorUpdateCount: query.state.errorUpdateCount + 1,
          errorUpdatedAt: Date.now(),
          fetchFailureCount: query.state.fetchFailureCount + 1,
          fetchFailureReason: error as Error,
          fetchStatus: "idle",
          status: "error",
        },
        { meta: "set by ConvexQueryClient" },
      );
    }
  }

  /**
   * Creates a WebSocket subscription for a specific page of a paginated query.
   */
  private subscribeToPage(
    queryHash: string,
    funcRef: FunctionReference<"query">,
    baseArgs: Record<string, any>,
    cursor: string | null,
    numItems: number,
  ): { watch: Watch<any>; unsubscribe: () => void } {
    const fullArgs = {
      ...baseArgs,
      paginationOpts: { numItems, cursor },
    };

    const watch = this.convexClient.watchQuery(funcRef, fullArgs, {});
    const unsubscribe = watch.onUpdate(() => {
      this.onPaginatedPageUpdate(queryHash, cursor);
    });

    return { watch, unsubscribe };
  }

  /**
   * Handles updates from a page subscription for paginated queries.
   * Updates just the specific page in the infinite query data.
   */
  private onPaginatedPageUpdate(queryHash: string, cursor: string | null) {
    const sub = this.paginatedSubscriptions[queryHash];
    if (!sub) return;

    const pageSub = sub.pages.get(cursor);
    if (!pageSub) return;

    const query = this.queryClient.getQueryCache().get(queryHash);
    if (!query) return;

    let result: { ok: true; value: any } | { ok: false; error: unknown };
    try {
      result = { ok: true, value: pageSub.watch.localQueryResult() };
    } catch (error) {
      result = { ok: false, error };
    }

    if (result.ok) {
      const newPageData = result.value;
      // Update just this page in the infinite query data
      this.queryClient.setQueryData(
        query.queryKey,
        (oldData: { pages: any[]; pageParams: (string | null)[] } | undefined) => {
          if (!oldData?.pages) return oldData;

          const pageIndex = oldData.pageParams.indexOf(cursor);
          if (pageIndex === -1) return oldData;

          const newPages = [...oldData.pages];
          newPages[pageIndex] = newPageData;

          return { ...oldData, pages: newPages };
        },
      );
    } else {
      const { error } = result;
      // Set error state similar to regular queries
      query?.setState(
        {
          error: error as Error,
          errorUpdateCount: query.state.errorUpdateCount + 1,
          errorUpdatedAt: Date.now(),
          fetchFailureCount: query.state.fetchFailureCount + 1,
          fetchFailureReason: error as Error,
          fetchStatus: "idle",
          status: "error",
        },
        { meta: "set by ConvexQueryClient" },
      );
    }
  }

  subscribeInner(queryCache: QueryCache): () => void {
    if (isServer) return () => {};
    return queryCache.subscribe((event) => {
      // Handle paginated queries separately
      if (isConvexPaginatedQuery(event.query.queryKey)) {
        switch (event.type) {
          case "added": {
            // Initialize tracking for this paginated query
            const [_, func, baseArgs] = event.query.queryKey;
            const numItems =
              (event.query.options.meta as Record<string, unknown> | undefined)
                ?.__convexNumItems ?? 10;

            this.paginatedSubscriptions[event.query.queryHash] = {
              funcRef: func,
              baseArgs,
              numItems: numItems as number,
              pages: new Map(),
            };
            break;
          }
          case "updated": {
            // When data is successfully fetched, subscribe to new pages
            if (
              event.action.type === "success" &&
              event.action.data &&
              typeof event.action.data === "object" &&
              "pageParams" in event.action.data
            ) {
              const data = event.action.data as {
                pageParams: (string | null)[];
              };
              const sub = this.paginatedSubscriptions[event.query.queryHash];
              if (!sub) break;

              // Subscribe to any new pages
              for (const cursor of data.pageParams) {
                if (!sub.pages.has(cursor)) {
                  const pageSub = this.subscribeToPage(
                    event.query.queryHash,
                    sub.funcRef,
                    sub.baseArgs,
                    cursor,
                    sub.numItems,
                  );
                  sub.pages.set(cursor, pageSub);
                }
              }
            }
            break;
          }
          case "removed": {
            // Clean up all page subscriptions
            const sub = this.paginatedSubscriptions[event.query.queryHash];
            if (sub) {
              for (const pageSub of sub.pages.values()) {
                pageSub.unsubscribe();
              }
              delete this.paginatedSubscriptions[event.query.queryHash];
            }
            break;
          }
        }
        return;
      }

      // Handle regular convex queries
      if (!isConvexQuery(event.query.queryKey)) {
        return;
      }
      if (isConvexSkipped(event.query.queryKey)) {
        return;
      }

      switch (event.type) {
        // A query has been GC'd so no stale value will be available.
        // In Convex this means we should unsubscribe.
        case "removed": {
          this.subscriptions[event.query.queryHash].unsubscribe();
          delete this.subscriptions[event.query.queryHash];
          break;
        }
        // A query has been requested for the first time.
        // Subscribe to the query so we hold on to it.
        case "added": {
          // There exists only one watch per subscription; but
          // watches are stateless anyway, they're just util code.
          const [_, func, args, _opts] = event.query.queryKey as [
            "convexQuery",
            FunctionReference<"query">,
            any,
            {},
          ];
          const watch = this.convexClient.watchQuery(
            func,
            args,
            // TODO pass journals through
            {},
          );
          const unsubscribe = watch.onUpdate(() => {
            this.onUpdateQueryKeyHash(event.query.queryHash);
          });

          this.subscriptions[event.query.queryHash] = {
            queryKey: event.query.queryKey,
            watch,
            unsubscribe,
          };
          break;
        }
        // Runs when a useQuery mounts
        case "observerAdded": {
          break;
        }
        // Runs when a useQuery unmounts
        case "observerRemoved": {
          if (event.query.getObserversCount() === 0) {
            // The last useQuery subscribed to this query has unmounted.
            // But don't clean up yet, after gcTime a "removed" event
            // will notify that it's time to drop the subscription to
            // the Convex backend.
          }
          break;
        }
        // Fires once per useQuery hook
        case "observerResultsUpdated": {
          break;
        }
        case "updated": {
          if (
            event.action.type === "setState" &&
            event.action.setStateOptions?.meta === "set by ConvexQueryClient"
          ) {
            // This one was caused by us. This may be important to know for
            // breaking infinite loops in the future.
            break;
          }
          break;
        }
        case "observerOptionsUpdated": {
          // observerOptionsUpdated, often because of an unmemoized query key
          break;
        }
      }
    });
  }

  /**
   * Returns a promise for the query result of a query key containing
   * `['convexQuery', FunctionReference, args]` and subscribes via WebSocket
   * to future updates.
   *
   * You can provide a custom fetch function for queries that are not
   * Convex queries.
   */
  queryFn(
    otherFetch: QueryFunction<unknown, QueryKey> = throwBecauseNotConvexQuery,
  ) {
    return async <
      ConvexQueryReference extends FunctionReference<"query", "public">,
    >(
      context: QueryFunctionContext<ReadonlyArray<unknown>>,
    ): Promise<FunctionReturnType<ConvexQueryReference>> => {
      if (isConvexSkipped(context.queryKey)) {
        throw new Error(
          "Skipped query should not actually be run, should { enabled: false }",
        );
      }
      // Only queries can be requested consistently (at a previous timestamp),
      // actions and mutations run at the latest timestamp.
      if (isConvexQuery(context.queryKey)) {
        const [_, func, args] = context.queryKey;
        if (isServer) {
          if (this.ssrQueryMode === "consistent") {
            return await this.serverHttpClient!.consistentQuery(func, args);
          } else {
            return await this.serverHttpClient!.query(func, args);
          }
        } else {
          return await this.convexClient.query(func, args);
        }
      }
      if (isConvexPaginatedQuery(context.queryKey)) {
        const [_, func, baseArgs] = context.queryKey;
        const pageParam = context.pageParam as ConvexPageParam;
        const numItems =
          (context.meta as Record<string, unknown> | undefined)?.__convexNumItems ??
          10;

        const fullArgs = {
          ...baseArgs,
          paginationOpts: { numItems, cursor: pageParam },
        };

        if (isServer) {
          if (this.ssrQueryMode === "consistent") {
            return await this.serverHttpClient!.consistentQuery(func, fullArgs);
          } else {
            return await this.serverHttpClient!.query(func, fullArgs);
          }
        } else {
          return await this.convexClient.query(func, fullArgs);
        }
      }
      if (isConvexAction(context.queryKey)) {
        const [_, func, args] = context.queryKey;
        if (isServer) {
          return await this.serverHttpClient!.action(func, args);
        } else {
          return await this.convexClient.action(func, args);
        }
      }
      return otherFetch(context);
    };
  }

  /**
   * Set this globally to use Convex query functions.
   *
   * ```ts
   * const queryClient = new QueryClient({
   *   defaultOptions: {
   *    queries: {
   *       queryKeyHashFn: convexQueryClient.hashFn(),
   *     },
   *   },
   * });
   *
   * You can provide a custom hash function for keys that are not for Convex
   * queries.
   */
  hashFn(otherHashKey: (queryKey: ReadonlyArray<unknown>) => string = hashKey) {
    return (queryKey: ReadonlyArray<unknown>) => {
      if (isConvexQuery(queryKey)) {
        return hash(queryKey);
      }
      if (isConvexPaginatedQuery(queryKey)) {
        return hashPaginatedQuery(queryKey);
      }
      return otherHashKey(queryKey);
    };
  }

  /**
   * Query options factory for Convex query function subscriptions.
   *
   * ```
   * useQuery(client.queryOptions(api.foo.bar, args))
   * ```
   *
   * If you need to specify other options spread it:
   * ```
   * useQuery({
   *   ...convexQueryClient.queryOptions(api.foo.bar, args),
   *   placeholderData: { name: "me" }
   * });
   * ```
   */
  queryOptions = <ConvexQueryReference extends FunctionReference<"query">>(
    funcRef: ConvexQueryReference,
    queryArgs: FunctionArgs<ConvexQueryReference>,
  ): Pick<
    UseQueryOptions<
      FunctionReturnType<ConvexQueryReference>,
      Error,
      FunctionReturnType<ConvexQueryReference>,
      ["convexQuery", ConvexQueryReference, FunctionArgs<ConvexQueryReference>]
    >,
    "queryKey" | "queryFn" | "staleTime"
  > => {
    return {
      queryKey: [
        "convexQuery",
        // Make query key serializable
        getFunctionName(funcRef) as unknown as typeof funcRef,
        // TODO bigints are not serializable
        queryArgs,
      ],
      queryFn: this.queryFn(),
      staleTime: Infinity,
      // We cannot set hashFn here, see
      // https://github.com/TanStack/query/issues/4052#issuecomment-1296174282
      // so the developer must set it globally.
    };
  };

  /**
   * Infinite query options factory for Convex paginated query function subscriptions.
   * Use this with TanStack Query's `useInfiniteQuery` hook.
   *
   * ```tsx
   * useInfiniteQuery(client.infiniteQueryOptions(api.messages.list, { channelId }, { initialNumItems: 20 }))
   * ```
   *
   * If you need to specify other options, spread it:
   * ```tsx
   * useInfiniteQuery({
   *   ...convexQueryClient.infiniteQueryOptions(api.messages.list, { channelId }, { initialNumItems: 20 }),
   *   gcTime: 60000,
   * });
   * ```
   */
  infiniteQueryOptions = <Query extends PaginatedQueryReference>(
    funcRef: Query,
    args: PaginatedQueryArgs<Query>,
    options: ConvexPaginatedQueryOptions,
  ): {
    queryKey: readonly [
      "convexPaginatedQuery",
      Query,
      PaginatedQueryArgs<Query>,
    ];
    queryFn: QueryFunction<PaginationResult<PaginatedQueryItem<Query>>, readonly unknown[], ConvexPageParam>;
    initialPageParam: ConvexPageParam;
    getNextPageParam: (
      lastPage: PaginationResult<PaginatedQueryItem<Query>>,
    ) => ConvexPageParam | undefined;
    staleTime: number;
    meta: { __convexNumItems: number };
  } => {
    return {
      queryKey: [
        "convexPaginatedQuery",
        getFunctionName(funcRef) as unknown as Query,
        args,
      ] as const,
      queryFn: this.queryFn(),
      initialPageParam: null as ConvexPageParam,
      getNextPageParam: (
        lastPage: PaginationResult<PaginatedQueryItem<Query>>,
      ): ConvexPageParam | undefined => {
        if (lastPage.isDone) {
          return undefined;
        }
        return lastPage.continueCursor;
      },
      staleTime: Infinity,
      meta: { __convexNumItems: options.initialNumItems },
    };
  };
}

type ConvexQueryArgsOrSkip<FuncRef extends FunctionReference<"query">> =
  keyof FunctionArgs<FuncRef> extends never
    ? [args?: EmptyObject | "skip"]
    : EmptyObject extends FunctionArgs<FuncRef>
      ? [args?: FunctionArgs<FuncRef> | "skip"]
      : [args: FunctionArgs<FuncRef> | "skip"];

/**
 * Query options factory for Convex query function subscriptions.
 * This options factory requires the `convexQueryClient.queryFn()` has been set
 * as the default `queryFn` globally.
 *
 * ```
 * useQuery(convexQuery(api.foo.bar, args))
 * ```
 *
 * If you need to specify other options spread it:
 * ```
 * useQuery({
 *   ...convexQuery(api.messages.list, { channel: 'dogs' }),
 *   placeholderData: [{ name: "Snowy" }]
 * });
 * ```
 */
export function convexQuery<
  ConvexQueryReference extends FunctionReference<"query">,
>(
  funcRef: ConvexQueryReference,
  ...argsOrSkip: ConvexQueryArgsOrSkip<ConvexQueryReference>
): (typeof argsOrSkip)[0] extends "skip"
  ? Pick<
      UseQueryOptions<
        FunctionReturnType<ConvexQueryReference>,
        Error,
        FunctionReturnType<ConvexQueryReference>,
        [
          "convexQuery",
          ConvexQueryReference,
          FunctionArgs<ConvexQueryReference>,
        ]
      >,
      "queryKey" | "queryFn" | "staleTime" | "enabled"
    >
  : Pick<
      UseSuspenseQueryOptions<
        FunctionReturnType<ConvexQueryReference>,
        Error,
        FunctionReturnType<ConvexQueryReference>,
        [
          "convexQuery",
          ConvexQueryReference,
          FunctionArgs<ConvexQueryReference>,
        ]
      >,
      "queryKey" | "queryFn" | "staleTime"
    > {
  const queryArgs = argsOrSkip[0];
  const finalArgs = queryArgs ?? {};
  return {
    queryKey: [
      "convexQuery",
      // Make query key serializable
      getFunctionName(funcRef) as unknown as typeof funcRef,
      // TODO bigints are not serializable
      finalArgs === "skip" ? "skip" : finalArgs,
    ],
    staleTime: Infinity,
    ...(finalArgs === "skip" ? { enabled: false } : {}),
  } as any;
}

type ConvexActionArgsOrSkip<FuncRef extends FunctionReference<"action">> =
  keyof FunctionArgs<FuncRef> extends never
    ? [args?: EmptyObject | "skip"]
    : EmptyObject extends FunctionArgs<FuncRef>
      ? [args?: FunctionArgs<FuncRef> | "skip"]
      : [args: FunctionArgs<FuncRef> | "skip"];

/**
 * Query options factory for Convex action function.
 * Not that Convex actions are live updating: they follow the normal react-query
 * semantics of refreshing on
 *
 * ```
 * useQuery(convexQuery(api.weather.now, { location: "SF" }))
 * ```
 *
 * If you need to specify other options spread it:
 * ```
 * useQuery({
 *   ...convexAction(api.weather.now, { location: "SF" }),
 *   placeholderData: { status: "foggy and cool" }
 * });
 * ```
 */
export function convexAction<
  ConvexActionReference extends FunctionReference<"action">,
>(
  funcRef: ConvexActionReference,
  ...argsOrSkip: ConvexActionArgsOrSkip<ConvexActionReference>
): Pick<
  UseQueryOptions<
    FunctionReturnType<ConvexActionReference>,
    Error,
    FunctionReturnType<ConvexActionReference>,
    ["convexAction", ConvexActionReference, FunctionArgs<ConvexActionReference>]
  >,
  "queryKey" | "queryFn" | "staleTime" | "enabled"
> {
  const args = argsOrSkip[0];
  const finalArgs = args ?? {};
  return {
    queryKey: [
      "convexAction",
      // Make query key serializable
      getFunctionName(funcRef) as unknown as typeof funcRef,
      // TODO bigints are not serializable
      finalArgs === "skip" ? {} : finalArgs,
    ],
    staleTime: Infinity,
    ...(finalArgs === "skip" ? { enabled: false } : {}),
  } as any;
}

/**
 * Options for convexPaginatedQuery.
 */
export interface ConvexPaginatedQueryOptions {
  /** Number of items to load per page */
  initialNumItems: number;
}

/**
 * Infinite query options factory for Convex paginated query functions.
 * Use this with TanStack Query's `useInfiniteQuery` hook for real-time
 * paginated data with "Load More" or infinite scroll UIs.
 *
 * This options factory requires that `convexQueryClient.queryFn()` has been set
 * as the default `queryFn` globally.
 *
 * Each loaded page will automatically subscribe to real-time updates.
 *
 * ```tsx
 * const { data, fetchNextPage, hasNextPage } = useInfiniteQuery(
 *   convexPaginatedQuery(api.messages.list, { channelId }, { initialNumItems: 20 })
 * );
 *
 * // Flatten pages into a single array
 * const messages = data?.pages.flatMap(page => page.page) ?? [];
 * ```
 *
 * For conditional queries, pass "skip" as the args:
 * ```tsx
 * useInfiniteQuery(
 *   convexPaginatedQuery(api.messages.byUser, userId ? { userId } : "skip", { initialNumItems: 10 })
 * )
 * ```
 */
export function convexPaginatedQuery<Query extends PaginatedQueryReference>(
  funcRef: Query,
  args: PaginatedQueryArgs<Query> | "skip",
  options: ConvexPaginatedQueryOptions,
): {
  queryKey: readonly [
    "convexPaginatedQuery",
    Query,
    PaginatedQueryArgs<Query> | Record<string, never>,
  ];
  initialPageParam: ConvexPageParam;
  getNextPageParam: (
    lastPage: PaginationResult<PaginatedQueryItem<Query>>,
  ) => ConvexPageParam | undefined;
  staleTime: number;
  meta: { __convexNumItems: number };
  enabled?: boolean;
} {
  const skip = args === "skip";
  const baseArgs = skip ? ({} as Record<string, never>) : args;

  return {
    queryKey: [
      "convexPaginatedQuery",
      // Make query key serializable
      getFunctionName(funcRef) as unknown as Query,
      // TODO bigints are not serializable
      baseArgs,
    ] as const,
    initialPageParam: null as ConvexPageParam,
    getNextPageParam: (
      lastPage: PaginationResult<PaginatedQueryItem<Query>>,
    ): ConvexPageParam | undefined => {
      if (lastPage.isDone) {
        return undefined;
      }
      return lastPage.continueCursor;
    },
    staleTime: Infinity,
    meta: { __convexNumItems: options.initialNumItems },
    ...(skip ? { enabled: false } : {}),
  } as any;
}

function throwBecauseNotConvexQuery(
  context: QueryFunctionContext<ReadonlyArray<unknown>>,
) {
  throw new Error("Query key is not for a Convex Query: " + context.queryKey);
}
