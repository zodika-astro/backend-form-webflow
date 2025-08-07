// schemas/birthchartSchema.js
const { z } = require('zod');

const birthchartSchema = z.object({
  name: z.string().min(3, 'name must have at least 3 characters'),
  social_name: z.string().optional(),
  email: z.string().email('invalid email format'),
  birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date format must be YYYY-MM-DD'),
  birth_time: z.string().regex(/^\d{2}:\d{2}$/, 'time format must be HH:MM'),
  birth_place: z.string().min(2, 'birth place must have at least 2 characters')
});

module.exports = { birthchartSchema };
