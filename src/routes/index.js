const express    = require("express");

const healthRoutes     = require("./health.routes");
const authRoutes       = require("./auth.routes");
const userRoutes       = require("./users.routes");
const productRoutes    = require("./products.routes");
const adminProductRoutes = require("./admin-products.routes");
const categoryRoutes   = require("./categories.routes");
const subcategoryRoutes = require("./subcategories.routes");
const brandRoutes      = require("./brands.routes");
const quoteRoutes      = require("./quotes.routes");
const insightRoutes      = require("./insights.routes");
const adminInsightRoutes = require("./admin-insights.routes");
const testimonialRoutes      = require("./testimonials.routes");
const adminTestimonialRoutes = require("./admin-testimonials.routes");

const router = express.Router();

router.use("/health",     healthRoutes);
router.use("/auth",       authRoutes);
router.use("/users",      userRoutes);
router.use("/products",   productRoutes);
router.use("/admin/products", adminProductRoutes);
router.use("/categories", categoryRoutes);
router.use("/subcategories", subcategoryRoutes);
router.use("/brands",     brandRoutes);
router.use("/quotes",     quoteRoutes);
router.use("/insights", insightRoutes);
router.use("/admin/insights", adminInsightRoutes);
router.use("/testimonials", testimonialRoutes);
router.use("/admin/testimonials", adminTestimonialRoutes);

module.exports = router;
