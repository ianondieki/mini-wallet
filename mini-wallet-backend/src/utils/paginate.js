/**
 * Run a paginated, filtered query against a Mongoose model.
 *
 * @param {import('mongoose').Model} model
 * @param {object} options
 * @param {object} [options.filter={}]    Mongo filter.
 * @param {number} [options.page=1]
 * @param {number} [options.limit=10]
 * @param {object} [options.sort={createdAt:-1}]
 * @param {string|object} [options.populate]  Mongoose populate spec.
 * @param {string} [options.select]
 * @returns {Promise<{items: any[], pagination: object}>}
 */
export const paginate = async (
  model,
  {
    filter = {},
    page = 1,
    limit = 10,
    sort = { createdAt: -1 },
    populate = null,
    select = null,
  } = {}
) => {
  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
  const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 10));
  const skip = (safePage - 1) * safeLimit;

  let query = model.find(filter).sort(sort).skip(skip).limit(safeLimit);
  if (populate) query = query.populate(populate);
  if (select) query = query.select(select);

  const [items, total] = await Promise.all([
    query.lean().exec(),
    model.countDocuments(filter).exec(),
  ]);

  return {
    items,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
      hasNextPage: safePage * safeLimit < total,
      hasPrevPage: safePage > 1,
    },
  };
};

export default paginate;
