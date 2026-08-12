import cors from "cors";
import express from "express";
import { router } from "./routes";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";

export const app = express();

app.use(cors());
app.use(express.json());

app.use(router);

app.use(notFoundHandler);
app.use(errorHandler);
