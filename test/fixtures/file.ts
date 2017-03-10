import { VersionInfo } from "publish-api"

export function foo(options: Electron.RequestOptions, error: Error, info: VersionInfo, name: "foo" | "bar"): void {
}

export function bool() {
  return true
}

export function num() {
  return 1
}

export type PublishProvider = "github" | "bintray" | "s3" | "generic"

/**
 * Can be specified in the [config](https://github.com/electron-userland/electron-builder/wiki/Options#configuration-options) or any platform- or target- specific options.
 * 
 * If `GH_TOKEN` is set — defaults to `[{provider: "github"}]`.
 * 
 * If `BT_TOKEN` is set and `GH_TOKEN` is not set — defaults to `[{provider: "bintray"}]`.
 */
export interface PublishConfiguration {
  /**
   * The provider.
   */
  readonly provider: PublishProvider

  /**
   * The owner.
   */
  readonly owner?: string | null

  readonly token?: string | null
}


/**
 * Amazon S3 options. `https` must be used, so, if you use direct Amazon S3 endpoints, format `https://s3.amazonaws.com/bucket_name` [must be used](http://stackoverflow.com/a/11203685/1910191). And do not forget to make files/directories public.
 * @see [Getting your credentials](http://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/getting-your-credentials.html).
 */
export interface S3Options extends PublishConfiguration {
  /**
   * The bucket name.
   */
  readonly bucket: string

  /**
   * The directory path.
   * @default /
   */
  readonly path?: string | null

  /**
   * The channel.
   * @default latest
   */
  readonly channel?: string | null

  /**
   * The ACL.
   * @default public-read
   */
  readonly acl?: "private" | "public-read" | null

  /**
   * The type of storage to use for the object.
   * @default STANDARD
   */
  readonly storageClass?: "STANDARD" | "REDUCED_REDUNDANCY" | "STANDARD_IA" | null
}
