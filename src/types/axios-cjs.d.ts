declare module "axios/dist/node/axios.cjs" {
  import type { AxiosStatic } from "axios";
  const axios: AxiosStatic;
  export default axios;
}
